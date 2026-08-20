import {
  aggregateSchedules,
  cronBuilderExpression,
  filterScheduleRows,
  inspectCronTiming,
  scheduleMutationCapability,
  zonedWallTimeToInstant,
  type AggregatedScheduleRow,
  type ScheduleFilters,
} from "@t3tools/client-runtime/schedules";
import {
  OccurrenceId,
  ProjectId,
  ScheduleId,
  isProviderAvailable,
  type EnvironmentId,
  type ModelSelection,
  type ScheduleCommand,
  type ScheduleDetail,
  type ScheduleHistoryCursor,
  type ScheduleHistoryEntry,
  type ScheduleState,
  type ScheduleTiming,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  CircleAlertIcon,
  CopyIcon,
  PencilIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction,
} from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { isElectron } from "../../env";
import { newCommandId, randomUUID } from "../../lib/utils";
import { scheduleEnvironment, useWebEnvironmentSchedules } from "../../state/schedules";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjects } from "../../state/entities";
import { cn } from "../../lib/utils";
import { useBranches } from "../../state/queries";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  latestScheduleHistoryListText,
  modelSelectionValue,
  prependOlderScheduleHistory,
  reconcileScheduleEditorDefaults,
  scheduleFailureAttentionVersion,
  scheduleHistoryEntryKey,
  schedulePauseFieldLabel,
  scheduleWorktreeCapability,
} from "./SchedulesPage.logic";

const ALL_STATES = ["enabled", "paused", "completed", "failed"] as const;
const EMPTY_REFS = Object.freeze([]);
const SCHEDULE_HISTORY_PAGE_SIZE = 50;
const SCHEDULE_HISTORY_RENDER_LIMIT = 200;

interface ScheduleEditorDraft {
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

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function defaultRunAtInput(): string {
  const next = new Date(Date.now() + 60 * 60 * 1_000);
  next.setSeconds(0, 0);
  const offset = next.getTimezoneOffset() * 60_000;
  return new Date(next.getTime() - offset).toISOString().slice(0, 16);
}

function wallTimeInputForInstant(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}T${read("hour")}:${read("minute")}`;
}

function emptyDraft(environmentId = ""): ScheduleEditorDraft {
  return {
    name: "",
    prompt: "",
    environmentId,
    projectId: "",
    timingType: "one-time",
    runAt: defaultRunAtInput(),
    cron: "0 9 * * 1-5",
    timeZone: browserTimeZone(),
    modelSelection: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceMode: "local",
    workspaceCustomized: false,
    baseBranch: "origin/HEAD",
    createPaused: false,
  };
}

function formatTiming(row: AggregatedScheduleRow): string {
  if (row.timing.type === "one-time") {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: row.timeZone,
    }).format(new Date(row.timing.runAt));
  }
  return `${row.timing.expression} · ${row.timeZone}`;
}

function formatTimestamp(value: string | null, timeZone?: string): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(value));
}

function commandFailure(result: { readonly _tag: string }): boolean {
  return result._tag === "Failure";
}

function notifyCommandFailure(title: string): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: "The Environment rejected the Schedule change.",
    }),
  );
}

export function SchedulesPage({ openCreateInitially = false }: { openCreateInitially?: boolean }) {
  const { environments } = useWebEnvironmentSchedules();
  const projects = useProjects();
  const dispatch = useAtomCommand(scheduleEnvironment.dispatch);
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(openCreateInitially);
  const [editingTarget, setEditingTarget] = useState<{
    readonly environmentId: EnvironmentId;
    readonly scheduleId: ScheduleId;
  } | null>(null);
  const [draft, setDraft] = useState<ScheduleEditorDraft>(() => emptyDraft());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [environmentFilter, setEnvironmentFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [stateFilter, setStateFilter] = useState<ScheduleState | "">("");
  const [failureFilter, setFailureFilter] = useState<ScheduleFilters["failures"]>("all");
  const [pending, setPending] = useState(false);

  const projections = useMemo(
    () =>
      environments.map((entry) => ({
        environmentId: entry.environment.environmentId,
        environmentLabel: entry.environment.label,
        source: entry.source,
        online: entry.online,
        supportsSchedules: entry.supportsSchedules,
        snapshotSequence: entry.snapshotSequence,
        schedules: entry.schedules,
      })),
    [environments],
  );
  const rows = useMemo(() => aggregateSchedules(projections), [projections]);
  const filters = useMemo<ScheduleFilters>(
    () => ({
      environmentIds: new Set(environmentFilter ? [environmentFilter as EnvironmentId] : []),
      projectIds: new Set(projectFilter ? [ProjectId.make(projectFilter)] : []),
      states: new Set(stateFilter ? [stateFilter] : []),
      failures: failureFilter,
    }),
    [environmentFilter, failureFilter, projectFilter, stateFilter],
  );
  const filteredRows = useMemo(
    () =>
      filterScheduleRows(rows, filters).toSorted((left, right) =>
        left.name.localeCompare(right.name),
      ),
    [filters, rows],
  );
  const environmentById = useMemo(
    () => new Map(environments.map((entry) => [entry.environment.environmentId, entry])),
    [environments],
  );
  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );
  const selected =
    selectedKey === null
      ? null
      : (rows.find((row) => `${row.environmentId}:${row.id}` === selectedKey) ?? null);

  useEffect(() => {
    if (draft.environmentId) return;
    const first = environments.find((entry) => entry.online && entry.supportsSchedules);
    if (!first) return;
    setDraft((current) => ({ ...current, environmentId: first.environment.environmentId }));
  }, [draft.environmentId, environments]);

  const runCommand = async (environmentId: EnvironmentId, command: ScheduleCommand) => {
    setPending(true);
    try {
      const result = await dispatch({ environmentId, input: command });
      if (commandFailure(result)) {
        notifyCommandFailure("Schedule change failed");
        return false;
      }
      return true;
    } finally {
      setPending(false);
    }
  };

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    const environment = environmentById.get(draft.environmentId as EnvironmentId);
    if (!environment || !environment.online || !environment.supportsSchedules) return;
    if (
      !draft.name.trim() ||
      !draft.prompt.trim() ||
      !draft.projectId ||
      draft.modelSelection === null
    )
      return;
    if (draft.timingType === "cron") {
      const inspection = inspectCronTiming({
        expression: draft.cron,
        timeZone: draft.timeZone,
        after: Date.now(),
      });
      if (!inspection.valid) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Invalid recurring Schedule",
            description: inspection.error ?? "Check the cron expression.",
          }),
        );
        return;
      }
    }
    const oneTime =
      draft.timingType === "one-time" ? zonedWallTimeToInstant(draft.runAt, draft.timeZone) : null;
    if (oneTime !== null && !oneTime.valid) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Invalid one-time Schedule",
          description: oneTime.error ?? "Check the date, time, and time zone.",
        }),
      );
      return;
    }
    const timing: ScheduleTiming =
      draft.timingType === "one-time"
        ? { type: "one-time", runAt: oneTime!.instant! }
        : { type: "cron", expression: draft.cron.trim() };
    const definition = {
      projectId: ProjectId.make(draft.projectId),
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      timing,
      timeZone: draft.timeZone,
      execution: {
        modelSelection: draft.modelSelection,
        runtimeMode: draft.runtimeMode,
        interactionMode: draft.interactionMode,
        workspaceMode: draft.workspaceMode,
        baseBranch:
          draft.workspaceMode === "worktree" ? draft.baseBranch.trim() || "origin/HEAD" : null,
      },
    };
    const succeeded = await runCommand(
      environment.environment.environmentId,
      editingTarget === null
        ? {
            type: "schedule.create",
            commandId: newCommandId(),
            scheduleId: ScheduleId.make(randomUUID()),
            ...definition,
            state: draft.createPaused ? "paused" : "enabled",
          }
        : {
            type: "schedule.update",
            commandId: newCommandId(),
            scheduleId: editingTarget.scheduleId,
            ...definition,
          },
    );
    if (!succeeded) return;
    setShowCreate(false);
    setEditingTarget(null);
    setDraft(emptyDraft(environment.environment.environmentId));
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: editingTarget === null ? "Schedule created" : "Schedule updated",
      }),
    );
  };

  const handleLifecycle = async (
    row: AggregatedScheduleRow,
    type:
      | "schedule.pause"
      | "schedule.resume"
      | "schedule.run-now"
      | "schedule.acknowledge-failures",
  ) => {
    await runCommand(row.environmentId, {
      type,
      commandId: newCommandId(),
      scheduleId: ScheduleId.make(row.id),
      ...(type === "schedule.run-now" ? { occurrenceId: OccurrenceId.make(randomUUID()) } : {}),
    } as ScheduleCommand);
  };

  const handleDelete = async (row: AggregatedScheduleRow) => {
    const confirmation = requestConfirmDialog(
      `Delete “${row.name}”? Its Schedule history will be removed. Threads and worktrees it already created will remain.`,
      { variant: "destructive" },
    );
    if (!(await (confirmation ?? Promise.resolve(false)))) return;
    const succeeded = await runCommand(row.environmentId, {
      type: "schedule.delete",
      commandId: newCommandId(),
      scheduleId: ScheduleId.make(row.id),
    });
    if (succeeded) setSelectedKey(null);
  };

  const duplicate = (row: AggregatedScheduleRow, detail: ScheduleDetail | null) => {
    setEditingTarget(null);
    setDraft({
      ...emptyDraft(row.environmentId),
      name: `${row.name} copy`,
      prompt: detail?.prompt ?? "",
      projectId: row.projectId,
      timingType: row.timing.type,
      runAt:
        row.timing.type === "one-time"
          ? wallTimeInputForInstant(row.timing.runAt, row.timeZone)
          : defaultRunAtInput(),
      cron: row.timing.type === "cron" ? row.timing.expression : "0 9 * * 1-5",
      timeZone: row.timeZone,
      modelSelection: row.execution.modelSelection,
      runtimeMode: row.execution.runtimeMode,
      interactionMode: row.execution.interactionMode,
      workspaceMode: row.execution.workspaceMode,
      workspaceCustomized: true,
      baseBranch: row.execution.baseBranch ?? "origin/HEAD",
      createPaused: row.state === "paused",
    });
    setShowCreate(true);
  };

  const edit = (row: AggregatedScheduleRow, detail: ScheduleDetail) => {
    setEditingTarget({ environmentId: row.environmentId, scheduleId: ScheduleId.make(row.id) });
    setDraft({
      ...emptyDraft(row.environmentId),
      name: row.name,
      prompt: detail.prompt,
      projectId: row.projectId,
      timingType: row.timing.type,
      runAt:
        row.timing.type === "one-time"
          ? wallTimeInputForInstant(row.timing.runAt, row.timeZone)
          : defaultRunAtInput(),
      cron: row.timing.type === "cron" ? row.timing.expression : "0 9 * * 1-5",
      timeZone: row.timeZone,
      modelSelection: row.execution.modelSelection,
      runtimeMode: row.execution.runtimeMode,
      interactionMode: row.execution.interactionMode,
      workspaceMode: row.execution.workspaceMode,
      workspaceCustomized: true,
      baseBranch: row.execution.baseBranch ?? "origin/HEAD",
      createPaused: false,
    });
    setShowCreate(true);
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          className={cn(
            "flex shrink-0 items-center px-3 sm:px-5",
            isElectron
              ? "drag-region h-[52px] wco:h-[env(titlebar-area-height)]"
              : "h-[var(--workspace-topbar-height)]",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <WorkspaceBreadcrumb ariaLabel="Schedules breadcrumb">
            <WorkspaceBreadcrumbItem current>Schedules</WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <Button
            className="ml-auto"
            size="sm"
            onClick={() => {
              setEditingTarget(null);
              setDraft(emptyDraft());
              setShowCreate(true);
            }}
          >
            <PlusIcon /> Create Schedule
          </Button>
        </header>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto grid w-full max-w-7xl gap-5 px-5 py-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <main className="min-w-0 space-y-4">
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                <FilterSelect
                  value={environmentFilter}
                  onChange={setEnvironmentFilter}
                  label="Environment"
                >
                  <option value="">All Environments</option>
                  {environments.map((entry) => (
                    <option
                      key={entry.environment.environmentId}
                      value={entry.environment.environmentId}
                    >
                      {entry.environment.label}
                    </option>
                  ))}
                </FilterSelect>
                <FilterSelect value={projectFilter} onChange={setProjectFilter} label="Project">
                  <option value="">All Projects</option>
                  {projects.map((project) => (
                    <option key={`${project.environmentId}:${project.id}`} value={project.id}>
                      {project.title}
                    </option>
                  ))}
                </FilterSelect>
                <FilterSelect
                  value={stateFilter}
                  onChange={(value) => setStateFilter(value as ScheduleState | "")}
                  label="State"
                >
                  <option value="">All States</option>
                  {ALL_STATES.map((state) => (
                    <option key={state} value={state}>
                      {state}
                    </option>
                  ))}
                </FilterSelect>
                <FilterSelect
                  value={failureFilter}
                  onChange={(value) => setFailureFilter(value as ScheduleFilters["failures"])}
                  label="Failures"
                >
                  <option value="all">All</option>
                  <option value="only">Has unacknowledged failure</option>
                  <option value="without">Without failure</option>
                </FilterSelect>
              </div>

              {showCreate ? (
                <ScheduleEditor
                  draft={draft}
                  editing={editingTarget !== null}
                  environments={environments}
                  projects={projects}
                  pending={pending}
                  onChange={setDraft}
                  onCancel={() => {
                    setShowCreate(false);
                    setEditingTarget(null);
                  }}
                  onSubmit={handleCreate}
                />
              ) : null}

              {filteredRows.length === 0 ? (
                <Card>
                  <CardPanel className="flex min-h-48 flex-col items-center justify-center gap-2 text-center">
                    <CalendarClockIcon className="size-8 text-muted-foreground" />
                    <p className="font-medium">No Schedules to show</p>
                    <p className="max-w-md text-sm text-muted-foreground">
                      Schedules live on their Environment and start a fresh Thread when an
                      Occurrence triggers.
                    </p>
                  </CardPanel>
                </Card>
              ) : (
                <div className="space-y-2">
                  {filteredRows.map((row) => {
                    const key = `${row.environmentId}:${row.id}`;
                    const project = projectByKey.get(`${row.environmentId}:${row.projectId}`);
                    const latest = row.latestHistory
                      ? latestScheduleHistoryListText(row.latestHistory, (value) =>
                          formatTimestamp(value, row.timeZone),
                        )
                      : null;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setSelectedKey(key)}
                        className={cn(
                          "grid w-full gap-2 rounded-xl border bg-card p-4 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_auto]",
                          !row.online && "opacity-55 grayscale",
                          selectedKey === key && "border-ring bg-accent/40",
                        )}
                      >
                        <span className="min-w-0">
                          <span className="flex items-center gap-2">
                            <span className="truncate font-medium">{row.name}</span>
                            <Badge variant={row.state === "failed" ? "error" : "secondary"}>
                              {row.state}
                            </Badge>
                            {row.unacknowledgedFailure ? (
                              <CircleAlertIcon className="size-4 text-destructive" />
                            ) : null}
                          </span>
                          <span className="mt-1 block truncate text-xs text-muted-foreground">
                            {row.environmentLabel} · {project?.title ?? "Missing Project"} ·{" "}
                            {formatTiming(row)}
                          </span>
                          <span className="mt-1 block truncate text-xs text-muted-foreground">
                            {latest ? `Latest: ${latest}` : "Latest: No Occurrences yet"}
                          </span>
                        </span>
                        <span className="text-xs text-muted-foreground sm:text-right">
                          <span className="block">Next</span>
                          <span className="block text-foreground">
                            {formatTimestamp(row.nextOccurrenceAt, row.timeZone)}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </main>

            <aside className="min-w-0">
              {selected ? (
                <ScheduleDetailCard
                  key={selectedKey}
                  row={selected}
                  pending={pending}
                  onAcknowledge={() => handleLifecycle(selected, "schedule.acknowledge-failures")}
                  onDelete={() => handleDelete(selected)}
                  onDuplicate={duplicate}
                  onEdit={edit}
                  onPauseResume={() =>
                    handleLifecycle(
                      selected,
                      selected.state === "paused" ? "schedule.resume" : "schedule.pause",
                    )
                  }
                  onRunNow={() => handleLifecycle(selected, "schedule.run-now")}
                  onOpenThread={(threadId) =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: { environmentId: selected.environmentId, threadId },
                    })
                  }
                />
              ) : (
                <Card className="sticky top-4">
                  <CardPanel className="py-10 text-center text-sm text-muted-foreground">
                    Select a Schedule to inspect its configuration and compact history.
                  </CardPanel>
                </Card>
              )}
            </aside>
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function FilterSelect(props: {
  readonly value: string;
  readonly label: string;
  readonly onChange: (value: string) => void;
  readonly children: ReactNode;
  readonly disabled?: boolean;
}) {
  return (
    <label className="space-y-1 text-xs text-muted-foreground">
      <span>{props.label}</span>
      <select
        className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground"
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {props.children}
      </select>
    </label>
  );
}

function ScheduleEditor(props: {
  readonly draft: ScheduleEditorDraft;
  readonly editing: boolean;
  readonly environments: ReturnType<typeof useWebEnvironmentSchedules>["environments"];
  readonly projects: ReturnType<typeof useProjects>;
  readonly pending: boolean;
  readonly onChange: Dispatch<SetStateAction<ScheduleEditorDraft>>;
  readonly onCancel: () => void;
  readonly onSubmit: (event: FormEvent) => void;
}) {
  const [cronEditorMode, setCronEditorMode] = useState<"builder" | "manual">("builder");
  const environment = props.environments.find(
    (entry) => entry.environment.environmentId === props.draft.environmentId,
  );
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
    <Card>
      <CardHeader>
        <CardTitle>{props.editing ? "Edit Schedule" : "Create Schedule"}</CardTitle>
        <CardDescription>
          The saved execution choices will not move when defaults change.
        </CardDescription>
      </CardHeader>
      <CardPanel>
        <form className="grid gap-4 md:grid-cols-2" onSubmit={props.onSubmit}>
          <EditorField label="Short name">
            <Input
              required
              value={props.draft.name}
              onChange={(event) => patchDraft({ name: event.target.value })}
            />
          </EditorField>
          <FilterSelect
            disabled={props.editing}
            label="Environment"
            value={props.draft.environmentId}
            onChange={(environmentId) =>
              patchDraft({ environmentId, projectId: "", modelSelection: null })
            }
          >
            <option value="">Select Environment</option>
            {props.environments.map((entry) => (
              <option
                key={entry.environment.environmentId}
                disabled={!entry.online || !entry.supportsSchedules}
                value={entry.environment.environmentId}
              >
                {entry.environment.label}
                {entry.online ? "" : " (offline)"}
              </option>
            ))}
          </FilterSelect>
          <EditorField label="Prompt" className="md:col-span-2">
            <Textarea
              required
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
              <div className="mb-2 flex gap-1 rounded-lg bg-muted p-1">
                <button
                  className={cn(
                    "flex-1 rounded-md px-2 py-1 text-xs",
                    cronEditorMode === "builder" && "bg-background shadow-sm",
                  )}
                  type="button"
                  onClick={() => setCronEditorMode("builder")}
                >
                  Visual builder
                </button>
                <button
                  className={cn(
                    "flex-1 rounded-md px-2 py-1 text-xs",
                    cronEditorMode === "manual" && "bg-background shadow-sm",
                  )}
                  type="button"
                  onClick={() => setCronEditorMode("manual")}
                >
                  Manual cron
                </button>
              </div>
              {cronEditorMode === "builder" ? (
                <select
                  aria-label="Recurring Schedule preset"
                  className="h-8 w-full rounded-lg border border-input bg-background px-2 text-sm text-foreground"
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
                  value={props.draft.cron}
                  onChange={(event) => patchDraft({ cron: event.target.value })}
                />
              )}
              <p className="mt-1 font-mono text-xs text-muted-foreground">{props.draft.cron}</p>
              {cronInspection?.error ? (
                <p className="mt-1 text-xs text-destructive">{cronInspection.error}</p>
              ) : null}
              {cronInspection?.highFrequency ? (
                <p className="mt-1 text-xs text-warning-foreground">
                  This can create 288 Threads per day and about 105,000 per year. Phoenix does not
                  automatically delete Threads or worktrees.
                </p>
              ) : null}
            </EditorField>
          )}
          <EditorField label="IANA time zone">
            <Input
              required
              value={props.draft.timeZone}
              onChange={(event) => patchDraft({ timeZone: event.target.value })}
            />
            {cronInspection?.valid ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Next:{" "}
                {cronInspection.occurrences
                  .map((value) => formatTimestamp(value, props.draft.timeZone))
                  .join(" · ")}
              </p>
            ) : null}
          </EditorField>
          <FilterSelect
            label="Provider and model"
            value={modelSelectionValue(props.draft.modelSelection)}
            onChange={(model) =>
              patchDraft({
                modelSelection:
                  modelOptions.find((option) => option.value === model)?.selection ?? null,
              })
            }
          >
            <option value="">Select model</option>
            {modelOptions.map((model) => (
              <option key={model.value} value={model.value}>
                {model.label}
              </option>
            ))}
          </FilterSelect>
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
          {schedulePauseFieldLabel(props.editing) ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={props.draft.createPaused}
                onChange={(event) => patchDraft({ createPaused: event.target.checked })}
              />
              {schedulePauseFieldLabel(props.editing)}
            </label>
          ) : null}
          <div className="flex justify-end gap-2 md:col-span-2">
            <Button type="button" variant="ghost" onClick={props.onCancel}>
              Cancel
            </Button>
            <Button
              disabled={
                props.pending ||
                !environment?.online ||
                !environment.supportsSchedules ||
                worktreeUnavailable ||
                worktreeProbePending
              }
              type="submit"
            >
              {props.editing ? "Save changes" : "Save Schedule"}
            </Button>
          </div>
        </form>
      </CardPanel>
    </Card>
  );
}

function EditorField(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <label className={cn("space-y-1 text-xs text-muted-foreground", props.className)}>
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

function ScheduleDetailCard(props: {
  readonly row: AggregatedScheduleRow;
  readonly pending: boolean;
  readonly onRunNow: () => void;
  readonly onPauseResume: () => void;
  readonly onDelete: () => void;
  readonly onAcknowledge: () => void;
  readonly onDuplicate: (row: AggregatedScheduleRow, detail: ScheduleDetail | null) => void;
  readonly onEdit: (row: AggregatedScheduleRow, detail: ScheduleDetail) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const target = {
    environmentId: props.row.environmentId,
    input: { scheduleId: ScheduleId.make(props.row.id), revision: props.row.revision },
  };
  const detailQuery = useEnvironmentQuery(scheduleEnvironment.detail(target));
  const detail = detailQuery.data;
  const attemptedAcknowledgements = useRef(new Set<string>());
  const attentionVersion = scheduleFailureAttentionVersion(
    props.row.unacknowledgedFailure,
    props.row.latestHistory,
    props.row.updatedAt,
  );

  useEffect(() => {
    if (
      attentionVersion === null ||
      !props.row.online ||
      attemptedAcknowledgements.current.has(attentionVersion)
    )
      return;
    attemptedAcknowledgements.current.add(attentionVersion);
    props.onAcknowledge();
  }, [attentionVersion, props.onAcknowledge, props.row.online]);

  const capability = scheduleMutationCapability({
    environmentLabel: props.row.environmentLabel,
    online: props.row.online,
    supportsSchedules: props.row.supportsSchedules,
  });
  return (
    <Card className={cn("sticky top-4", !props.row.online && "opacity-75")}>
      <CardHeader>
        <CardTitle>{props.row.name}</CardTitle>
        <CardDescription>
          {props.row.environmentLabel} · {capability.allowed ? "Online" : capability.reason}
        </CardDescription>
      </CardHeader>
      <CardPanel className="space-y-5">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted-foreground">State</dt>
          <dd>{props.row.state}</dd>
          <dt className="text-muted-foreground">Timing</dt>
          <dd>{formatTiming(props.row)}</dd>
          <dt className="text-muted-foreground">Model</dt>
          <dd>{props.row.execution.modelSelection.model}</dd>
          <dt className="text-muted-foreground">Workspace</dt>
          <dd>{props.row.execution.workspaceMode}</dd>
        </dl>
        {detail?.prompt ? (
          <div>
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">Prompt</h3>
            <p className="whitespace-pre-wrap text-sm">{detail.prompt}</p>
          </div>
        ) : null}
        {detail ? (
          <ScheduleHistoryList
            key={`${props.row.revision}:${detail.id}:${detail.historyNextCursor ?? "complete"}`}
            detail={detail}
            environmentId={props.row.environmentId}
            online={props.row.online}
            timeZone={props.row.timeZone}
            onOpenThread={props.onOpenThread}
          />
        ) : (
          <div>
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">History</h3>
            <p className="text-sm text-muted-foreground">
              {detailQuery.error ?? "Loading recent history…"}
            </p>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!capability.allowed || props.pending}
            size="sm"
            onClick={props.onRunNow}
          >
            <PlayIcon />
            Run now
          </Button>
          {props.row.state === "enabled" || props.row.state === "paused" ? (
            <Button
              disabled={!capability.allowed || props.pending}
              size="sm"
              variant="outline"
              onClick={props.onPauseResume}
            >
              {props.row.state === "paused" ? <PlayIcon /> : <PauseIcon />}
              {props.row.state === "paused" ? "Resume" : "Pause"}
            </Button>
          ) : null}
          <Button
            disabled={!capability.allowed || props.pending || detail === null}
            size="sm"
            variant="outline"
            onClick={() => detail && props.onEdit(props.row, detail)}
          >
            <PencilIcon />
            Edit
          </Button>
          <Button
            disabled={!capability.allowed || props.pending || detail === null}
            size="sm"
            variant="outline"
            onClick={() => props.onDuplicate(props.row, detail)}
          >
            <CopyIcon />
            Duplicate
          </Button>
          <Button
            disabled={!capability.allowed || props.pending}
            size="sm"
            variant="ghost"
            onClick={props.onDelete}
          >
            <Trash2Icon />
            Delete
          </Button>
        </div>
      </CardPanel>
    </Card>
  );
}

function ScheduleHistoryList(props: {
  readonly detail: ScheduleDetail;
  readonly environmentId: EnvironmentId;
  readonly online: boolean;
  readonly timeZone: string;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const [entries, setEntries] = useState<ReadonlyArray<ScheduleHistoryEntry>>(props.detail.history);
  const [nextCursor, setNextCursor] = useState<ScheduleHistoryCursor | null>(
    props.detail.historyNextCursor,
  );
  const [requestedCursor, setRequestedCursor] = useState<ScheduleHistoryCursor | null>(null);
  const [loadedOlder, setLoadedOlder] = useState(false);
  const historyQuery = useEnvironmentQuery(
    requestedCursor === null
      ? null
      : scheduleEnvironment.history({
          environmentId: props.environmentId,
          input: {
            scheduleId: props.detail.id,
            cursor: requestedCursor,
            limit: SCHEDULE_HISTORY_PAGE_SIZE,
          },
        }),
  );

  useEffect(() => {
    const page = historyQuery.data;
    if (requestedCursor === null || page === null || page.scheduleId !== props.detail.id) return;
    setEntries((current) =>
      prependOlderScheduleHistory(page.entries, current, SCHEDULE_HISTORY_RENDER_LIMIT),
    );
    setNextCursor(page.nextCursor);
    setLoadedOlder(true);
    setRequestedCursor(null);
  }, [historyQuery.data, props.detail.id, requestedCursor]);

  const resetToRecent = () => {
    setEntries(props.detail.history);
    setNextCursor(props.detail.historyNextCursor);
    setRequestedCursor(null);
    setLoadedOlder(false);
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">History</h3>
        {loadedOlder ? (
          <Button size="xs" variant="ghost" onClick={resetToRecent}>
            Back to recent
          </Button>
        ) : null}
      </div>
      {entries.length ? (
        <ol className="space-y-2">
          {entries.toReversed().map((entry) => (
            <li key={scheduleHistoryEntryKey(entry)} className="rounded-lg border p-2 text-xs">
              <span className="font-medium capitalize">{entry.type}</span>
              {entry.type === "failed" ? (
                <div className="mt-1 space-y-1 text-destructive">
                  <p>
                    {entry.code} · {entry.message}
                    {entry.count > 1 ? ` (${entry.count} times)` : ""}
                  </p>
                  <p className="text-muted-foreground">
                    {formatTimestamp(entry.firstFailedAt, props.timeZone)}
                    {entry.count > 1
                      ? ` – ${formatTimestamp(entry.lastFailedAt, props.timeZone)}`
                      : ""}
                  </p>
                </div>
              ) : null}
              {entry.type === "skipped" ? (
                <p className="mt-1 text-muted-foreground">
                  {entry.countIsLowerBound ? "At least " : ""}
                  {entry.count.toLocaleString("en-US")} Occurrences ·{" "}
                  {formatTimestamp(entry.firstScheduledFor, props.timeZone)} –{" "}
                  {formatTimestamp(entry.lastScheduledFor, props.timeZone)}
                </p>
              ) : null}
              {entry.type === "triggered" ? (
                <div className="mt-1 space-y-1">
                  <p className="text-muted-foreground">
                    {formatTimestamp(entry.triggeredAt, props.timeZone)}
                  </p>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => props.onOpenThread(entry.threadId)}
                  >
                    Open Thread
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">No Occurrences yet.</p>
      )}
      {historyQuery.error ? (
        <div className="mt-2 flex items-center gap-2 text-xs text-destructive">
          <span>{historyQuery.error}</span>
          <Button size="xs" variant="outline" onClick={historyQuery.refresh}>
            Try again
          </Button>
        </div>
      ) : null}
      {nextCursor !== null ? (
        <div className="mt-2">
          <Button
            disabled={!props.online || requestedCursor !== null}
            size="xs"
            variant="outline"
            onClick={() => setRequestedCursor(nextCursor)}
          >
            {requestedCursor === null ? "Load older" : "Loading…"}
          </Button>
          {!props.online ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Connect to this Environment to load older history. Recent history remains available
              offline.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
