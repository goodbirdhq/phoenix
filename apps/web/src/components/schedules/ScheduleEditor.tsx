import {
  cronBuilderExpression,
  currentScheduleTimeZone,
  defaultScheduleOneTimeInput,
  inspectCronTiming,
} from "@t3tools/client-runtime/schedules";
import { isProviderAvailable, type ModelSelection } from "@t3tools/contracts";
import { CalendarClockIcon, CodeIcon } from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useWebEnvironmentSchedules } from "../../state/schedules";
import { useProjects } from "../../state/entities";
import { useBranches } from "../../state/queries";
import { cn } from "../../lib/utils";
import { Select, SelectTrigger, SelectPopup, SelectItem } from "../ui/select";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { getDriverOption } from "../settings/providerDriverMeta";
import { EnvironmentIcon } from "../environments/EnvironmentIcon";
import { useClientSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  modelSelectionValue,
  scheduleDisplayTimestamp,
  reconcileScheduleEditorDefaults,
  schedulePauseFieldLabel,
  scheduleWorktreeCapability,
} from "./SchedulesPage.logic";
const EMPTY_REFS = Object.freeze([]);
export interface ScheduleEditorDraft {
  readonly name: string;
  readonly prompt: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly timingType: "one-time" | "cron";
  readonly runAt: string;
  readonly cron: string;
  readonly timeZone: string;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly interactionMode: "default" | "plan";
  readonly workspaceMode: "local" | "worktree";
  readonly workspaceCustomized: boolean;
  readonly baseBranch: string;
  readonly createPaused: boolean;
}

export function emptyDraft(environmentId = ""): ScheduleEditorDraft {
  return {
    name: "",
    prompt: "",
    environmentId,
    projectId: "",
    timingType: "one-time",
    runAt: defaultScheduleOneTimeInput(Date.now()),
    cron: "0 9 * * 1-5",
    timeZone: currentScheduleTimeZone(),
    modelSelection: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceMode: "local",
    workspaceCustomized: false,
    baseBranch: "origin/HEAD",
    createPaused: false,
  };
}

function FilterSelect(props: {
  readonly value: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly onChange: (value: string) => void;
  readonly children: ReactNode;
  readonly disabled?: boolean;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        {props.icon}
        {props.label}
      </span>
      <select
        className="h-10 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground"
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {props.children}
      </select>
    </label>
  );
}

export function ScheduleEditor(props: {
  readonly draft: ScheduleEditorDraft;
  readonly editing: boolean;
  readonly environments: ReturnType<typeof useWebEnvironmentSchedules>["environments"];
  readonly projects: ReturnType<typeof useProjects>;
  readonly pending: boolean;
  readonly canSave: boolean;
  readonly onChange: Dispatch<SetStateAction<ScheduleEditorDraft>>;
  readonly onCancel: () => void;
  readonly onSubmit: (event: FormEvent) => void;
}) {
  const appearance = useClientSettings((s) => s.environmentAppearance);
  const [cronEditorMode, setCronEditorMode] = useState<"builder" | "manual">("builder");
  const environment = props.environments.find(
    (entry) => entry.environment.environmentId === props.draft.environmentId,
  );
  const provider = environment?.environment.serverConfig?.providers.find(
    (p) => p.instanceId === props.draft.modelSelection?.instanceId,
  );
  const ProviderIcon = getDriverOption(provider?.driver)?.icon;
  const availableProjects = useMemo(
    () => props.projects.filter((project) => project.environmentId === props.draft.environmentId),
    [props.draft.environmentId, props.projects],
  );
  const selectedProject = availableProjects.find((project) => project.id === props.draft.projectId);
  const vcsRefs = useBranches({
    environmentId: environment?.environment.environmentId ?? null,
    cwd: selectedProject?.workspaceRoot ?? null,
  });
  const branchRefs = vcsRefs.data?.refs ?? EMPTY_REFS;
  const worktreeCapability = scheduleWorktreeCapability(vcsRefs.data?.isRepo ?? null);
  const worktreeUnavailable =
    props.draft.workspaceMode === "worktree" && !worktreeCapability.allowed;
  const vcsProbePending = vcsRefs.data === null && vcsRefs.isPending;
  const worktreeProbePending = props.draft.workspaceMode === "worktree" && vcsProbePending;
  const modelOptions = useMemo(
    () =>
      environment?.environment.serverConfig?.providers.flatMap((provider) =>
        provider.enabled && isProviderAvailable(provider)
          ? provider.models.map((model) => ({
              value: `${provider.instanceId}\u0000${model.slug}`,
              label: `${provider.displayName ?? provider.instanceId} · ${model.name}`,
              selection: { instanceId: provider.instanceId, model: model.slug } as ModelSelection,
              isDefault: model.isDefault === true,
              icon: getDriverOption(provider.driver)?.icon,
            }))
          : [],
      ) ?? [],
    [environment?.environment.serverConfig?.providers],
  );
  const cronInspection =
    props.draft.timingType === "cron"
      ? inspectCronTiming({
          expression: props.draft.cron,
          timeZone: props.draft.timeZone,
          after: Date.now(),
        })
      : null;
  const patchDraft = (patch: Partial<ScheduleEditorDraft>) =>
    props.onChange((current) => ({ ...current, ...patch }));

  useEffect(() => {
    props.onChange((current) =>
      reconcileScheduleEditorDefaults(current, {
        environmentId: props.draft.environmentId,
        projects: availableProjects,
        modelChoices: modelOptions,
        serverDefaultModelSelection:
          environment?.environment.serverConfig?.settings.textGenerationModelSelection,
        isRepo: selectedProject === undefined ? null : (vcsRefs.data?.isRepo ?? null),
        branchRefs,
        editing: props.editing,
      }),
    );
  }, [
    availableProjects,
    branchRefs,
    environment?.environment.serverConfig?.settings.textGenerationModelSelection,
    modelOptions,
    props.draft.baseBranch,
    props.draft.environmentId,
    props.draft.modelSelection,
    props.draft.projectId,
    props.draft.workspaceCustomized,
    props.draft.workspaceMode,
    props.editing,
    props.onChange,
    selectedProject?.defaultModelSelection,
    vcsRefs.data?.isRepo,
  ]);

  return (
    <div className="schedule-editor">
      <div>
        <form className="grid gap-x-5 gap-y-6 md:grid-cols-2" onSubmit={props.onSubmit}>
          <fieldset disabled={props.pending} className="contents">
            <EditorField label="Short name">
              <Input
                required
                maxLength={128}
                value={props.draft.name}
                onChange={(event) => patchDraft({ name: event.target.value })}
              />
            </EditorField>
            <FilterSelect
              disabled={props.editing}
              label="Environment"
              icon={
                environment && (
                  <EnvironmentIcon
                    environmentId={environment.environment.environmentId}
                    className="size-4"
                  />
                )
              }
              value={props.draft.environmentId}
              onChange={(environmentId) =>
                patchDraft({ environmentId, projectId: "", modelSelection: null })
              }
            >
              <option value="">Select Environment</option>
              {!environment && props.draft.environmentId && (
                <option value={props.draft.environmentId}>Unavailable environment</option>
              )}
              {props.environments.map((entry) => (
                <option
                  key={entry.environment.environmentId}
                  disabled={!entry.online || !entry.supportsSchedules}
                  value={entry.environment.environmentId}
                >
                  {appearance[entry.environment.environmentId]?.alias || entry.environment.label}
                  {entry.online ? "" : " (offline)"}
                </option>
              ))}
            </FilterSelect>
            <EditorField label="Prompt" className="md:col-span-2">
              <Textarea
                required
                maxLength={120000}
                className="min-h-[76px]"
                value={props.draft.prompt}
                onChange={(event) => patchDraft({ prompt: event.target.value })}
              />
            </EditorField>
            <FilterSelect
              label="Project"
              value={props.draft.projectId}
              onChange={(projectId) => {
                patchDraft({
                  projectId,
                  modelSelection: null,
                });
              }}
            >
              <option value="">Select Project</option>
              {props.draft.projectId && !selectedProject && (
                <option value={props.draft.projectId}>
                  Unavailable project · {props.draft.projectId}
                </option>
              )}
              {availableProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              label="Timing"
              value={props.draft.timingType}
              onChange={(timingType) =>
                patchDraft({ timingType: timingType as ScheduleEditorDraft["timingType"] })
              }
            >
              <option value="one-time">One time</option>
              <option value="cron">Recurring</option>
            </FilterSelect>
            <div className="grid gap-x-5 gap-y-3 md:col-span-2 md:grid-cols-2">
              {props.draft.timingType === "cron" && (
                <Tabs
                  className="md:col-span-2"
                  value={cronEditorMode}
                  onValueChange={(v) => setCronEditorMode(v === "manual" ? "manual" : "builder")}
                >
                  <TabsList
                    className="w-fit gap-1 rounded-lg border-0 bg-muted p-1 [&_button]:rounded-md [&_button]:border-0 [&_button]:px-3 [&_button]:py-2 [&_button[data-active]]:bg-background"
                    aria-label="Recurring rule editor"
                  >
                    <TabsTrigger value="builder">
                      <CalendarClockIcon className="size-4" />
                      Visual builder
                    </TabsTrigger>
                    <TabsTrigger value="manual">
                      <CodeIcon className="size-4" />
                      Manual cron
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              )}
              {props.draft.timingType === "one-time" ? (
                <EditorField label="Date and time">
                  <Input
                    nativeInput
                    required
                    type="datetime-local"
                    value={props.draft.runAt}
                    onChange={(event) => patchDraft({ runAt: event.target.value })}
                  />
                </EditorField>
              ) : (
                <EditorField label="Recurring rule">
                  {cronEditorMode === "builder" ? (
                    <select
                      aria-label="Recurring Schedule preset"
                      className="h-10 w-full rounded-lg border border-input bg-background px-3 text-[13px] text-foreground"
                      value={props.draft.cron}
                      onChange={(event) => patchDraft({ cron: event.target.value })}
                    >
                      <option value={cronBuilderExpression({ cadence: "minutes", interval: 5 })}>
                        Every 5 minutes
                      </option>
                      <option value={cronBuilderExpression({ cadence: "minutes", interval: 15 })}>
                        Every 15 minutes
                      </option>
                      <option value={cronBuilderExpression({ cadence: "hourly", minute: 0 })}>
                        Every hour
                      </option>
                      <option value="0 9 * * 1-5">Weekdays at 9:00</option>
                      <option
                        value={cronBuilderExpression({
                          cadence: "weekly",
                          weekday: 1,
                          hour: 9,
                          minute: 0,
                        })}
                      >
                        Mondays at 9:00
                      </option>
                      {![
                        "*/5 * * * *",
                        "*/15 * * * *",
                        "0 * * * *",
                        "0 9 * * 1-5",
                        "0 9 * * 1",
                      ].includes(props.draft.cron) ? (
                        <option value={props.draft.cron}>Custom saved rule</option>
                      ) : null}
                    </select>
                  ) : (
                    <Input
                      required
                      aria-label="Cron expression"
                      value={props.draft.cron}
                      onChange={(event) => patchDraft({ cron: event.target.value })}
                    />
                  )}
                </EditorField>
              )}
              <EditorField label="Time zone">
                <Input
                  required
                  value={props.draft.timeZone}
                  onChange={(event) => patchDraft({ timeZone: event.target.value })}
                />
              </EditorField>
              {props.draft.timingType === "cron" && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 md:col-span-2">
                  <code className="rounded-md bg-muted/40 px-2.5 py-1.5 text-[13px] leading-4">
                    {props.draft.cron}
                  </code>
                  {cronInspection?.valid && (
                    <p className="text-xs text-muted-foreground">
                      Next:{" "}
                      {cronInspection.occurrences
                        .map((value) => scheduleDisplayTimestamp(value, props.draft.timeZone))
                        .join(" · ")}
                    </p>
                  )}
                  {cronInspection?.error && (
                    <p className="w-full text-xs text-destructive">{cronInspection.error}</p>
                  )}
                  {cronInspection?.highFrequency && (
                    <p className="w-full text-xs text-warning-foreground">
                      A five-minute cadence can create up to 288 threads per day. Phoenix does not
                      automatically delete threads or worktrees.
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="grid gap-x-5 gap-y-4 md:col-span-2 md:grid-cols-2">
              <div className="space-y-4 border-t pt-4 md:col-span-2">
                <h2 className="text-base leading-[22px] font-semibold">Execution</h2>
                <p className="text-xs text-muted-foreground">
                  These choices are saved with the schedule, even if project defaults change.
                </p>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground">
                <span>Provider and model</span>
                <Select
                  value={modelSelectionValue(props.draft.modelSelection)}
                  disabled={props.pending}
                  onValueChange={(value) =>
                    patchDraft({
                      modelSelection:
                        modelOptions.find((o) => o.value === value)?.selection ?? null,
                    })
                  }
                >
                  <SelectTrigger
                    aria-label="Provider and model"
                    className="h-10 text-[13px] shadow-none"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {ProviderIcon && <ProviderIcon className="size-4" />}
                      <span className="truncate">
                        {modelOptions.find(
                          (o) => o.value === modelSelectionValue(props.draft.modelSelection),
                        )?.label ??
                          (props.draft.modelSelection
                            ? `Unavailable · ${props.draft.modelSelection.instanceId} · ${props.draft.modelSelection.model}`
                            : "Select model")}
                      </span>
                    </span>
                  </SelectTrigger>
                  <SelectPopup className="schedule-surface" alignItemWithTrigger={false}>
                    {modelOptions.map((model) => {
                      const Icon = model.icon;
                      return (
                        <SelectItem key={model.value} value={model.value}>
                          <span className="flex items-center gap-2">
                            {Icon && <Icon className="size-4" />}
                            {model.label}
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectPopup>
                </Select>
              </div>
              <FilterSelect
                label="Permission mode"
                value={props.draft.runtimeMode}
                onChange={(runtimeMode) =>
                  patchDraft({ runtimeMode: runtimeMode as ScheduleEditorDraft["runtimeMode"] })
                }
              >
                <option value="approval-required">Approval required</option>
                <option value="auto-accept-edits">Auto-accept edits</option>
                <option value="auto">Auto</option>
                <option value="full-access">Full access</option>
              </FilterSelect>
              <FilterSelect
                label="Interaction"
                value={props.draft.interactionMode}
                onChange={(interactionMode) =>
                  patchDraft({
                    interactionMode: interactionMode as ScheduleEditorDraft["interactionMode"],
                  })
                }
              >
                <option value="default">Build</option>
                <option value="plan">Plan</option>
              </FilterSelect>
              <FilterSelect
                label="Workspace"
                value={props.draft.workspaceMode}
                onChange={(workspaceMode) =>
                  patchDraft({
                    workspaceMode: workspaceMode as ScheduleEditorDraft["workspaceMode"],
                    workspaceCustomized: true,
                  })
                }
              >
                <option disabled={!worktreeCapability.allowed} value="worktree">
                  New worktree
                </option>
                <option value="local">Shared project workspace</option>
              </FilterSelect>
              {props.draft.workspaceMode === "worktree" ? (
                <EditorField label="Base branch">
                  <Input
                    required
                    value={props.draft.baseBranch}
                    onChange={(event) => patchDraft({ baseBranch: event.target.value })}
                  />
                </EditorField>
              ) : null}
              {props.draft.workspaceMode === "worktree" && worktreeCapability.allowed && (
                <p className="self-center text-xs text-muted-foreground">
                  A fresh worktree is created for each occurrence. Git projects use the remote
                  default branch initially.
                </p>
              )}
              {!worktreeCapability.allowed ? (
                <p
                  className={cn(
                    "text-xs md:col-span-2",
                    worktreeUnavailable ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {vcsRefs.data?.isRepo === false
                    ? "This Project is not backed by a Git repository. Use the shared project workspace."
                    : vcsProbePending
                      ? "Checking whether this Project is a Git repository. The shared project workspace remains available."
                      : "Phoenix could not confirm this Project is a Git repository. Use the shared project workspace."}
                </p>
              ) : null}
            </div>
            <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-2 border-t bg-background py-4 md:col-span-2">
              {schedulePauseFieldLabel(props.editing) ? (
                <label className="mr-auto flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={props.draft.createPaused}
                    onChange={(event) => patchDraft({ createPaused: event.target.checked })}
                  />
                  {schedulePauseFieldLabel(props.editing)}
                </label>
              ) : null}
              <Button
                className="schedule-control"
                type="button"
                variant="outline"
                onClick={props.onCancel}
              >
                Cancel
              </Button>
              <Button
                className="schedule-control"
                disabled={
                  props.pending ||
                  !props.canSave ||
                  !environment?.online ||
                  !environment.supportsSchedules ||
                  worktreeUnavailable ||
                  worktreeProbePending
                }
                type="submit"
              >
                {props.pending ? "Saving…" : props.editing ? "Save changes" : "Save schedule"}
              </Button>
            </div>
          </fieldset>
        </form>
      </div>
    </div>
  );
}

function EditorField(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <label
      className={cn("flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground", props.className)}
    >
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}
