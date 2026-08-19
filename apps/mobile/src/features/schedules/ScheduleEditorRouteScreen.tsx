import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { zonedWallTimeToInstant } from "@t3tools/client-runtime/schedules";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ScheduleId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScheduleExecution,
  type ScheduleTiming,
} from "@t3tools/contracts";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { buildModelOptions } from "../../lib/modelOptions";
import { uuidv4 } from "../../lib/uuid";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useServerConfigs } from "../../state/entities";
import { useBranches } from "../../state/queries";
import { appAtomRegistry } from "../../state/atom-registry";
import { scheduleEnvironment } from "../../state/schedules";
import { RUNTIME_MODE_CHOICES } from "../threads/thread-settings-options";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  canSelectScheduleWorkspaceMode,
  defaultScheduleWorkspaceMode,
  getFrequentScheduleWarning,
  previewCronOccurrences,
  preferredScheduleBaseBranch,
  scheduleBaseBranch,
  validateScheduleDraft,
  wallTimeInputForInstant,
  type ScheduleDraft,
} from "./schedule-screen-model";
import {
  useMobileScheduleDetail,
  useMobileScheduleOverview,
  useScheduleDispatch,
} from "./use-mobile-schedules";

type SourceParams = { readonly environmentId: string; readonly scheduleId: string };
type NewProps = StaticScreenProps<{ readonly environmentId?: string; readonly projectId?: string }>;
type SourceProps = StaticScreenProps<SourceParams>;
type EditorMode = "new" | "edit" | "duplicate";

const CRON_PRESETS = [
  { label: "Every 5 min", expression: "*/5 * * * *" },
  { label: "Hourly", expression: "0 * * * *" },
  { label: "Daily", expression: "0 9 * * *" },
  { label: "Weekly", expression: "0 9 * * 1" },
] as const;

function defaultOneTimeInput(): string {
  const value = new Date(Date.now() + 60 * 60_000);
  value.setSeconds(0, 0);
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 16);
}

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function ChoiceRow<T extends string>(props: {
  readonly choices: readonly { readonly value: T; readonly label: string }[];
  readonly value: T;
  readonly onChange: (value: T) => void;
}) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {props.choices.map((choice) => (
        <Pressable
          key={choice.value}
          accessibilityRole="button"
          className={
            choice.value === props.value
              ? "min-h-10 items-center justify-center rounded-full bg-primary px-4"
              : "min-h-10 items-center justify-center rounded-full bg-subtle px-4"
          }
          onPress={() => props.onChange(choice.value)}
        >
          <Text
            className={
              choice.value === props.value
                ? "text-xs font-t3-bold text-primary-foreground"
                : "text-xs font-t3-bold text-foreground"
            }
          >
            {choice.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export function ScheduleNewRouteScreen(props: NewProps) {
  return (
    <ScheduleEditor
      mode="new"
      requestedEnvironmentId={props.route.params?.environmentId}
      requestedProjectId={props.route.params?.projectId}
    />
  );
}

export function ScheduleEditRouteScreen(props: SourceProps) {
  return <ScheduleEditor mode="edit" source={props.route.params} />;
}

export function ScheduleDuplicateRouteScreen(props: SourceProps) {
  return <ScheduleEditor mode="duplicate" source={props.route.params} />;
}

function ScheduleEditor(props: {
  readonly mode: EditorMode;
  readonly source?: SourceParams;
  readonly requestedEnvironmentId?: string;
  readonly requestedProjectId?: string;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useMobileScheduleOverview();
  const configs = useServerConfigs();
  const dispatch = useScheduleDispatch();
  const sourceEnvironmentId = props.source ? EnvironmentId.make(props.source.environmentId) : null;
  const sourceScheduleId = props.source ? ScheduleId.make(props.source.scheduleId) : null;
  const sourceEnvironment = environments.find(
    (environment) => environment.environmentId === sourceEnvironmentId,
  );
  const sourceRevision =
    sourceEnvironment?.schedules.find((schedule) => schedule.id === sourceScheduleId)?.revision ??
    null;
  const sourceResult = useOptionalSourceDetail(
    sourceEnvironmentId,
    sourceScheduleId,
    sourceEnvironment?.online === true && sourceEnvironment.supportsSchedules,
    sourceRevision,
  );
  const sourceDetail = sourceResult.detail;
  const onlineEnvironments = environments.filter(
    (environment) => environment.online && environment.supportsSchedules,
  );
  const initialEnvironment =
    environments.find(
      (environment) => String(environment.environmentId) === props.requestedEnvironmentId,
    ) ??
    (props.mode === "edit"
      ? environments.find((environment) => environment.environmentId === sourceEnvironmentId)
      : onlineEnvironments[0]) ??
    null;
  const [environmentId, setEnvironmentId] = useState<EnvironmentId | null>(
    initialEnvironment?.environmentId ?? null,
  );
  const environment =
    environments.find((candidate) => candidate.environmentId === environmentId) ?? null;
  const [projectId, setProjectId] = useState<ProjectId | null>(() => {
    const requested = initialEnvironment?.projects.find(
      (project) => String(project.id) === props.requestedProjectId,
    );
    return requested?.id ?? initialEnvironment?.projects[0]?.id ?? null;
  });
  const project = environment?.projects.find((candidate) => candidate.id === projectId) ?? null;
  const branchState = useBranches({
    environmentId,
    cwd: project?.workspaceRoot || null,
    includeMatchingRemoteRefs: true,
  });
  const projectIsGit = branchState.data === null ? null : branchState.data.isRepo;
  const preferredBaseBranch = preferredScheduleBaseBranch(branchState.data?.refs ?? []);
  const projectSelectionKey =
    environmentId !== null && projectId !== null ? `${environmentId}:${projectId}` : null;
  const modelOptions = useMemo(
    () =>
      buildModelOptions(
        environmentId ? configs.get(environmentId) : null,
        project?.defaultModelSelection ?? null,
      ),
    [configs, environmentId, project?.defaultModelSelection],
  );
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [timingType, setTimingType] = useState<"one-time" | "cron">("one-time");
  const [runAtInput, setRunAtInput] = useState(defaultOneTimeInput);
  const [cron, setCron] = useState("0 9 * * *");
  const [manualCron, setManualCron] = useState(false);
  const [timeZone, setTimeZone] = useState(browserTimeZone);
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("full-access");
  const [interactionMode, setInteractionMode] = useState<ProviderInteractionMode>("default");
  const [workspaceSelection, setWorkspaceSelection] = useState<{
    readonly projectKey: string;
    readonly mode: "local" | "worktree";
    readonly baseBranch: string;
  } | null>(null);
  const [createPaused, setCreatePaused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [hydratedSourceId, setHydratedSourceId] = useState<string | null>(null);

  useEffect(() => {
    if (modelSelection !== null) return;
    const projectDefault = project?.defaultModelSelection;
    const option =
      modelOptions.find(
        (candidate) =>
          candidate.selection.instanceId === projectDefault?.instanceId &&
          candidate.selection.model === projectDefault.model,
      ) ??
      modelOptions.find((candidate) => candidate.isDefault) ??
      modelOptions[0];
    if (option) setModelSelection(option.selection);
  }, [modelOptions, modelSelection, project?.defaultModelSelection]);

  useEffect(() => {
    if (environmentId !== null || onlineEnvironments.length === 0) return;
    const next = onlineEnvironments[0]!;
    setEnvironmentId(next.environmentId);
    setProjectId(next.projects[0]?.id ?? null);
  }, [environmentId, onlineEnvironments]);

  useEffect(() => {
    if (!sourceDetail || hydratedSourceId === sourceDetail.id) return;
    setHydratedSourceId(sourceDetail.id);
    setEnvironmentId(sourceEnvironmentId);
    setProjectId(sourceDetail.projectId);
    setName(props.mode === "duplicate" ? `${sourceDetail.name} copy` : sourceDetail.name);
    setPrompt(sourceDetail.prompt);
    const sourceTiming = sourceDetail.timing;
    setTimingType(sourceTiming.type);
    if (sourceTiming.type === "one-time") {
      setRunAtInput(
        wallTimeInputForInstant(sourceTiming.runAt, sourceDetail.timeZone) ?? sourceTiming.runAt,
      );
    } else {
      setCron(sourceTiming.expression);
      setManualCron(!CRON_PRESETS.some((preset) => preset.expression === sourceTiming.expression));
    }
    setTimeZone(sourceDetail.timeZone);
    setModelSelection(sourceDetail.execution.modelSelection);
    setRuntimeMode(sourceDetail.execution.runtimeMode);
    setInteractionMode(sourceDetail.execution.interactionMode);
    setWorkspaceSelection({
      projectKey: `${sourceEnvironmentId}:${sourceDetail.projectId}`,
      mode: sourceDetail.execution.workspaceMode,
      baseBranch: sourceDetail.execution.baseBranch ?? "",
    });
    if (props.mode === "duplicate") setCreatePaused(sourceDetail.state === "paused");
  }, [hydratedSourceId, props.mode, sourceDetail, sourceEnvironmentId]);

  useEffect(() => {
    if (environment === null) return;
    if (!environment.projects.some((candidate) => candidate.id === projectId)) {
      setProjectId(environment.projects[0]?.id ?? null);
    }
  }, [environment, projectId]);

  const selectedWorkspace =
    workspaceSelection?.projectKey === projectSelectionKey ? workspaceSelection : null;
  const workspaceMode =
    projectIsGit === false
      ? "local"
      : (selectedWorkspace?.mode ?? defaultScheduleWorkspaceMode(projectIsGit) ?? "local");
  const baseBranch =
    workspaceMode === "worktree"
      ? (selectedWorkspace?.baseBranch ?? preferredBaseBranch ?? "")
      : "";

  const selectWorkspaceMode = (mode: "local" | "worktree") => {
    if (projectSelectionKey === null || !canSelectScheduleWorkspaceMode(projectIsGit, mode)) return;
    setWorkspaceSelection({ projectKey: projectSelectionKey, mode, baseBranch });
  };
  const setSelectedBaseBranch = (value: string) => {
    if (projectSelectionKey === null || projectIsGit !== true) return;
    setWorkspaceSelection({ projectKey: projectSelectionKey, mode: "worktree", baseBranch: value });
  };

  const execution: ScheduleExecution | null = modelSelection
    ? {
        modelSelection,
        runtimeMode,
        interactionMode,
        workspaceMode,
        baseBranch: scheduleBaseBranch(workspaceMode, baseBranch),
      }
    : null;
  const oneTime = zonedWallTimeToInstant(runAtInput, timeZone);
  const timing: ScheduleTiming =
    timingType === "one-time"
      ? { type: "one-time", runAt: oneTime.instant ?? "" }
      : { type: "cron", expression: cron.trim() || " " };
  const draft: ScheduleDraft | null =
    environmentId && projectId && execution
      ? {
          name,
          prompt,
          environmentId,
          projectId,
          timing,
          timeZone,
          execution,
          createPaused,
        }
      : null;
  const validation = draft
    ? validateScheduleDraft(
        draft,
        environments.map((candidate) => ({
          environmentId: String(candidate.environmentId),
          label: candidate.label,
          online: candidate.online && candidate.supportsSchedules,
          projects: candidate.projects.map((candidateProject) => ({
            projectId: String(candidateProject.id),
            title: candidateProject.title,
            isGit:
              candidate.environmentId === environmentId && candidateProject.id === projectId
                ? projectIsGit
                : null,
          })),
        })),
      )
    : { valid: false, errors: {} };
  const previews = timingType === "cron" ? previewCronOccurrences(cron, timeZone) : [];
  const warning = timingType === "cron" ? getFrequentScheduleWarning(cron) : null;
  const canChangeEnvironment = props.mode !== "edit";

  const cycleEnvironment = () => {
    if (!canChangeEnvironment || onlineEnvironments.length === 0) return;
    const current = onlineEnvironments.findIndex(
      (candidate) => candidate.environmentId === environmentId,
    );
    const next = onlineEnvironments[(current + 1) % onlineEnvironments.length]!;
    setEnvironmentId(next.environmentId);
    setProjectId(next.projects[0]?.id ?? null);
    setModelSelection(null);
  };
  const cycleProject = () => {
    if (!environment || environment.projects.length === 0) return;
    const current = environment.projects.findIndex((candidate) => candidate.id === projectId);
    setProjectId(environment.projects[(current + 1) % environment.projects.length]!.id);
    setModelSelection(null);
  };
  const cycleModel = () => {
    if (modelOptions.length === 0) return;
    const current = modelOptions.findIndex(
      (candidate) =>
        candidate.selection.instanceId === modelSelection?.instanceId &&
        candidate.selection.model === modelSelection.model,
    );
    setModelSelection(modelOptions[(current + 1) % modelOptions.length]!.selection);
  };

  const submit = async () => {
    if (
      !draft ||
      !execution ||
      !validation.valid ||
      submitting ||
      environmentId === null ||
      projectId === null
    )
      return;
    setSubmitting(true);
    const result = await dispatch(
      environmentId,
      props.mode === "edit" && sourceScheduleId
        ? {
            type: "schedule.update",
            commandId: CommandId.make(uuidv4()),
            scheduleId: sourceScheduleId,
            projectId,
            name: name.trim(),
            prompt: prompt.trim(),
            timing,
            timeZone,
            execution,
          }
        : {
            type: "schedule.create",
            commandId: CommandId.make(uuidv4()),
            scheduleId: ScheduleId.make(uuidv4()),
            projectId,
            name: name.trim(),
            prompt: prompt.trim(),
            timing,
            timeZone,
            execution,
            state: createPaused ? "paused" : "enabled",
          },
    );
    setSubmitting(false);
    if (!result.ok) {
      Alert.alert("Could not save Schedule", result.error);
      return;
    }
    if (props.mode === "edit" && sourceScheduleId !== null && sourceEnvironmentId !== null) {
      appAtomRegistry.refresh(
        scheduleEnvironment.detail({
          environmentId: sourceEnvironmentId,
          input: { scheduleId: sourceScheduleId },
        }),
      );
    }
    navigation.goBack();
  };

  const title =
    props.mode === "edit"
      ? "Edit Schedule"
      : props.mode === "duplicate"
        ? "Duplicate Schedule"
        : "New Schedule";
  if (props.source && sourceResult.isLoading && sourceDetail === null) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet">
        <ActivityIndicator />
      </View>
    );
  }
  if (props.source && sourceDetail === null) {
    return (
      <View className="flex-1 bg-sheet">
        {Platform.OS === "android" ? (
          <>
            <NativeStackScreenOptions options={{ headerShown: false }} />
            <AndroidScreenHeader title={title} onBack={() => navigation.goBack()} />
          </>
        ) : (
          <NativeStackScreenOptions options={{ title }} />
        )}
        <View className="flex-1 items-center justify-center px-5">
          <EmptyState
            title="Schedule unavailable"
            detail={
              sourceResult.error ??
              "This Schedule is not cached on this device. Reconnect its Environment and try again."
            }
          />
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title={title} onBack={() => navigation.goBack()} />
        </>
      ) : (
        <NativeStackScreenOptions options={{ title }} />
      )}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Definition" card>
          <Field label="Name" error={validation.errors.name}>
            <TextInput
              accessibilityLabel="Schedule name"
              className="min-h-11 rounded-xl bg-input px-3 text-base text-foreground"
              maxLength={128}
              onChangeText={setName}
              placeholder="Morning review"
              placeholderTextColorClassName="accent-placeholder"
              value={name}
            />
          </Field>
          <Field label="Prompt" error={validation.errors.prompt}>
            <TextInput
              accessibilityLabel="Schedule prompt"
              className="min-h-28 rounded-xl bg-input px-3 py-3 text-base text-foreground"
              multiline
              onChangeText={setPrompt}
              placeholder="What should the agent do?"
              placeholderTextColorClassName="accent-placeholder"
              textAlignVertical="top"
              value={prompt}
            />
          </Field>
          <PickerField
            label="Environment"
            value={environment?.label ?? "Choose Environment"}
            disabled={!canChangeEnvironment}
            error={validation.errors.environment}
            onPress={cycleEnvironment}
          />
          <PickerField
            label="Project"
            value={project?.title ?? "Choose Project"}
            disabled={environment === null}
            error={validation.errors.project}
            onPress={cycleProject}
          />
        </SettingsSection>

        <SettingsSection title="Timing" card>
          <View className="gap-3 p-4">
            <ChoiceRow
              choices={[
                { value: "one-time", label: "One time" },
                { value: "cron", label: "Recurring" },
              ]}
              value={timingType}
              onChange={setTimingType}
            />
            {timingType === "one-time" ? (
              <Field
                label="Future local time"
                detail="YYYY-MM-DDTHH:mm in the selected time zone."
                error={oneTime.valid ? validation.errors.timing : (oneTime.error ?? undefined)}
              >
                <TextInput
                  autoCapitalize="none"
                  className="min-h-11 rounded-xl bg-input px-3 text-base text-foreground"
                  onChangeText={setRunAtInput}
                  placeholder="2026-08-20T09:30"
                  placeholderTextColorClassName="accent-placeholder"
                  value={runAtInput}
                />
              </Field>
            ) : (
              <>
                <View className="flex-row flex-wrap gap-2">
                  {CRON_PRESETS.map((preset) => (
                    <Pressable
                      key={preset.expression}
                      className={
                        cron === preset.expression && !manualCron
                          ? "rounded-full bg-primary px-3 py-2.5"
                          : "rounded-full bg-subtle px-3 py-2.5"
                      }
                      onPress={() => {
                        setManualCron(false);
                        setCron(preset.expression);
                      }}
                    >
                      <Text
                        className={
                          cron === preset.expression && !manualCron
                            ? "text-xs font-t3-bold text-primary-foreground"
                            : "text-xs font-t3-bold text-foreground"
                        }
                      >
                        {preset.label}
                      </Text>
                    </Pressable>
                  ))}
                  <Pressable
                    className={
                      manualCron
                        ? "rounded-full bg-primary px-3 py-2.5"
                        : "rounded-full bg-subtle px-3 py-2.5"
                    }
                    onPress={() => setManualCron(true)}
                  >
                    <Text
                      className={
                        manualCron
                          ? "text-xs font-t3-bold text-primary-foreground"
                          : "text-xs font-t3-bold text-foreground"
                      }
                    >
                      Manual
                    </Text>
                  </Pressable>
                </View>
                {manualCron ? (
                  <TextInput
                    accessibilityLabel="Cron expression"
                    autoCapitalize="none"
                    autoCorrect={false}
                    className="min-h-11 rounded-xl bg-input px-3 font-mono text-base text-foreground"
                    onChangeText={setCron}
                    value={cron}
                  />
                ) : null}
                {validation.errors.timing ? (
                  <Text className="text-sm text-danger-foreground">{validation.errors.timing}</Text>
                ) : null}
                {previews.length === 3 ? (
                  <View className="gap-1 rounded-xl bg-subtle px-3 py-2">
                    <Text className="text-xs font-t3-bold text-foreground-muted">
                      Next three Occurrences
                    </Text>
                    {previews.map((value) => (
                      <Text key={value} className="text-sm text-foreground">
                        {new Intl.DateTimeFormat(undefined, {
                          dateStyle: "medium",
                          timeStyle: "short",
                          timeZone,
                        }).format(new Date(value))}
                      </Text>
                    ))}
                  </View>
                ) : null}
                {warning ? (
                  <Text className="text-sm leading-normal text-warning-foreground">{warning}</Text>
                ) : null}
              </>
            )}
            <Field label="Time zone" error={validation.errors.timeZone}>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                className="min-h-11 rounded-xl bg-input px-3 text-base text-foreground"
                onChangeText={setTimeZone}
                value={timeZone}
              />
            </Field>
          </View>
        </SettingsSection>

        <SettingsSection title="Execution" card>
          <PickerField
            label="Model"
            value={
              modelSelection
                ? `${modelSelection.instanceId}/${modelSelection.model}`
                : "No model available"
            }
            disabled={modelOptions.length === 0}
            onPress={cycleModel}
          />
          <View className="gap-3 border-b border-separator p-4">
            <Text className="text-sm font-t3-bold text-foreground-muted">Permissions</Text>
            <ChoiceRow
              choices={RUNTIME_MODE_CHOICES.map((choice) => ({
                value: choice.mode,
                label: choice.label,
              }))}
              value={runtimeMode}
              onChange={setRuntimeMode}
            />
          </View>
          <View className="gap-3 border-b border-separator p-4">
            <Text className="text-sm font-t3-bold text-foreground-muted">Interaction</Text>
            <ChoiceRow
              choices={[
                { value: "default", label: "Default" },
                { value: "plan", label: "Plan" },
              ]}
              value={interactionMode}
              onChange={setInteractionMode}
            />
          </View>
          <View className="gap-3 border-b border-separator p-4">
            <Text className="text-sm font-t3-bold text-foreground-muted">Workspace</Text>
            {projectIsGit === true ? (
              <ChoiceRow
                choices={[
                  { value: "worktree", label: "New worktree" },
                  { value: "local", label: "Shared workspace" },
                ]}
                value={workspaceMode}
                onChange={selectWorkspaceMode}
              />
            ) : projectIsGit === null ? (
              <>
                <ChoiceRow
                  choices={[{ value: "local", label: "Shared workspace" }]}
                  value={workspaceMode}
                  onChange={selectWorkspaceMode}
                />
                <Text className="text-sm text-foreground-muted">
                  {branchState.error ??
                    "Checking Git repository and refs… Worktrees are unavailable until this finishes."}
                </Text>
              </>
            ) : (
              <Text className="text-sm text-foreground-muted">
                Shared workspace · This Project is not a Git repository.
              </Text>
            )}
            {validation.errors.workspace ? (
              <Text className="text-sm text-danger-foreground">{validation.errors.workspace}</Text>
            ) : null}
          </View>
          {workspaceMode === "worktree" && projectIsGit === true ? (
            <Field
              label="Base branch"
              detail="Defaults to the configured default ref, then the current checkout."
            >
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                className="min-h-11 rounded-xl bg-input px-3 text-base text-foreground"
                onChangeText={setSelectedBaseBranch}
                placeholder="Select a default or current ref"
                placeholderTextColorClassName="accent-placeholder"
                value={baseBranch}
              />
            </Field>
          ) : null}
        </SettingsSection>

        {props.mode !== "edit" ? (
          <SettingsSection title="Initial state" card>
            <View className="flex-row items-center gap-4 p-4">
              <View className="min-w-0 flex-1">
                <Text className="text-base font-t3-bold text-foreground">Create Paused</Text>
                <Text className="text-sm text-foreground-muted">
                  Save without producing timed Occurrences.
                </Text>
              </View>
              <ThemedSwitch
                accessibilityLabel="Create Paused"
                value={createPaused}
                onValueChange={setCreatePaused}
              />
            </View>
          </SettingsSection>
        ) : null}

        <Pressable
          accessibilityRole="button"
          className="min-h-12 items-center justify-center rounded-full bg-primary px-5 disabled:bg-subtle-strong"
          disabled={!validation.valid || submitting || modelSelection === null}
          onPress={() => void submit()}
        >
          {submitting ? (
            <ActivityIndicator />
          ) : (
            <Text className="text-base font-t3-bold text-primary-foreground">
              {props.mode === "edit" ? "Save Changes" : "Create Schedule"}
            </Text>
          )}
        </Pressable>
      </ScrollView>
    </View>
  );
}

function useOptionalSourceDetail(
  environmentId: EnvironmentId | null,
  scheduleId: ScheduleId | null,
  liveEnabled: boolean,
  revision: number | null,
) {
  // Editor routes always supply both or neither. Stable sentinels keep Hooks unconditional.
  return useMobileScheduleDetail(environmentId, scheduleId, liveEnabled, revision);
}

function Field(props: {
  readonly label: string;
  readonly detail?: string;
  readonly error?: string;
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-2 border-b border-separator p-4 last:border-b-0">
      <Text className="text-sm font-t3-bold text-foreground-muted">{props.label}</Text>
      {props.children}
      {props.detail ? (
        <Text className="text-xs text-foreground-tertiary">{props.detail}</Text>
      ) : null}
      {props.error ? <Text className="text-sm text-danger-foreground">{props.error}</Text> : null}
    </View>
  );
}

function PickerField(props: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly error?: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      className="gap-2 border-b border-separator p-4 last:border-b-0 disabled:opacity-45"
      onPress={props.onPress}
    >
      <View className="flex-row items-center gap-3">
        <Text className="text-base font-t3-bold text-foreground">{props.label}</Text>
        <Text
          className="min-w-0 flex-1 text-right text-base text-foreground-muted"
          numberOfLines={1}
        >
          {props.value}
        </Text>
      </View>
      {props.error ? <Text className="text-sm text-danger-foreground">{props.error}</Text> : null}
    </Pressable>
  );
}
