import {
  aggregateSchedules,
  defaultScheduleOneTimeInput,
  inspectCronTiming,
  scheduleWallTimeInputForInstant,
  zonedWallTimeToInstant,
  type AggregatedScheduleRow,
} from "@t3tools/client-runtime/schedules";
import { ProjectId, ScheduleId, type ScheduleDetail, type ThreadId } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CalendarClockIcon,
  CalendarIcon,
  HistoryIcon,
  LayoutGridIcon,
  PlusIcon,
  RepeatIcon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from "react";
import { isElectron } from "../../env";
import { newCommandId, randomUUID, cn } from "../../lib/utils";
import { scheduleEnvironment, useWebEnvironmentSchedules } from "../../state/schedules";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useProjects } from "../../state/entities";
import { useClientSettings } from "../../hooks/useSettings";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { PageHeading } from "../patterns/PageHeading";
import { EnvironmentIcon } from "../environments/EnvironmentIcon";
import { getDriverOption } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { ScheduleActions, useSchedulePermission } from "./ScheduleActions";
import { ScheduleHistory, ScheduleHistoryTable } from "./ScheduleHistory";
import { ScheduleEditor, emptyDraft, type ScheduleEditorDraft } from "./ScheduleEditor";
import {
  scheduleFailureAttentionVersion,
  scheduleDisplayTimestamp,
  scheduleRepeatSummary,
} from "./SchedulesPage.logic";
import "./schedules.css";

const retainedDrafts = new Map<string, ScheduleEditorDraft>();

export function SchedulesPage() {
  const { isReady, environments } = useWebEnvironmentSchedules();
  const appearance = useClientSettings((s) => s.environmentAppearance);
  const route = useSearch({ from: "/schedules" });
  const navigate = useNavigate();
  const rows = useMemo(
    () =>
      aggregateSchedules(
        environments.map((e) => ({
          ...e,
          environmentId: e.environment.environmentId,
          environmentLabel: appearance[e.environment.environmentId]?.alias || e.environment.label,
        })),
      ),
    [environments, appearance],
  );
  const selected =
    rows.find((row) => row.environmentId === route.environment && row.id === route.schedule) ??
    (!route.schedule ? rows[0] : undefined);
  const loading =
    !isReady ||
    environments.some((e) => e.online && e.supportsSchedules && !e.hasSnapshot && !e.error);
  const missingTarget = !selected && !loading;
  const editor = !!(route.create || route.edit || route.duplicate);
  const owning = environments.find((e) => e.environment.environmentId === selected?.environmentId);
  const detailQuery = useEnvironmentQuery(
    selected
      ? scheduleEnvironment.detail({
          environmentId: selected.environmentId,
          input: { scheduleId: ScheduleId.make(selected.id), revision: selected.revision },
        })
      : null,
  );
  const goBack = () =>
    void navigate({
      to: "/schedules",
      search: {
        ...(selected ? { environment: selected.environmentId, schedule: selected.id } : {}),
        tab: route.tab ?? "overview",
      },
    });
  const create = () => void navigate({ to: "/schedules", search: { create: randomUUID() } });
  return (
    <SidebarInset className="schedule-surface usage-surface h-dvh min-h-0 overflow-hidden bg-background text-foreground isolate">
      <header
        className={cn(
          "flex h-[52px] shrink-0 items-center border-b px-4 sm:px-8",
          isElectron && "drag-region wco:h-[env(titlebar-area-height)]",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <WorkspaceBreadcrumb ariaLabel="Schedules breadcrumb">
          <WorkspaceBreadcrumbItem className="font-normal text-foreground">
            Schedules
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current className="text-xs font-normal text-muted-foreground">
            {editor
              ? route.edit
                ? "Edit schedule"
                : route.duplicate
                  ? "Duplicate schedule"
                  : "Create schedule"
              : (selected?.name ?? "Overview")}
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <main className="flex min-w-0 flex-col gap-6 p-4 sm:p-8">
          {editor ? (
            (route.edit || route.duplicate) && !detailQuery.data ? (
              <ScheduleMessage
                title={
                  missingTarget
                    ? "Schedule unavailable"
                    : detailQuery.error
                      ? "Could not load this schedule"
                      : "Loading schedule…"
                }
                description={
                  missingTarget
                    ? "This schedule may have been deleted or its environment is unavailable. Return to choose another schedule."
                    : (detailQuery.error ?? "Loading the saved prompt and execution settings.")
                }
                action={
                  <Button
                    variant="outline"
                    onClick={detailQuery.error ? detailQuery.refresh : goBack}
                  >
                    {detailQuery.error ? "Try again" : "Back"}
                  </Button>
                }
              />
            ) : (
              <ScheduleEditorJourney
                key={
                  route.edit
                    ? `edit:${selected?.environmentId}:${selected?.id}`
                    : route.duplicate
                      ? `duplicate:${selected?.environmentId}:${selected?.id}`
                      : "create"
                }
                source={selected}
                detail={detailQuery.data}
                editing={!!route.edit}
                duplicating={!!route.duplicate}
                environments={environments}
                onBack={goBack}
              />
            )
          ) : selected ? (
            <ScheduleDetailView
              key={`${selected.environmentId}:${selected.id}`}
              row={selected}
              detail={detailQuery.data}
              error={detailQuery.error}
              refresh={detailQuery.refresh}
            />
          ) : (
            <ScheduleMessage
              title={
                !isReady ||
                environments.some(
                  (e) => e.online && e.supportsSchedules && !e.hasSnapshot && !e.error,
                )
                  ? "Loading schedules…"
                  : route.schedule
                    ? "Schedule unavailable"
                    : environments.some((e) => e.error)
                      ? "Could not load schedules"
                      : environments.some((e) => !e.hasSnapshot)
                        ? "Schedules unavailable"
                        : "No schedules yet"
              }
              description={
                environments.find((e) => e.error)?.error ??
                (route.schedule
                  ? "It may have been deleted, or its environment is unavailable. Choose a schedule from the sidebar."
                  : environments.some((e) => !e.hasSnapshot)
                    ? "Some environments have no cached schedule data. Reconnect them to see their schedules."
                    : "Run a prompt once or on a recurring schedule. Each occurrence starts a fresh thread on its owning environment.")
              }
              action={
                <Button className="schedule-control" onClick={create}>
                  <PlusIcon className="size-4" />
                  Create schedule
                </Button>
              }
            />
          )}
          {!editor && owning?.error && (
            <p role="alert" className="text-sm text-destructive">
              {owning.error}
            </p>
          )}
        </main>
      </ScrollArea>
    </SidebarInset>
  );
}

function ScheduleMessage({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-72 flex-col items-start justify-center gap-4">
      <CalendarClockIcon className="size-7 text-muted-foreground" />
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="max-w-xl text-sm text-muted-foreground">{description}</p>
      {action}
    </div>
  );
}

function ScheduleDetailView({
  row,
  detail,
  error,
  refresh,
}: {
  row: AggregatedScheduleRow;
  detail: ScheduleDetail | null;
  error: string | null;
  refresh: () => void;
}) {
  const projects = useProjects();
  const { environments } = useWebEnvironmentSchedules();
  const route = useSearch({ from: "/schedules" });
  const navigate = useNavigate();
  const permission = useSchedulePermission(row);
  const dispatch = useAtomCommand(scheduleEnvironment.dispatch);
  const seen = useRef(new Set<string>());
  const attention = scheduleFailureAttentionVersion(
    row.unacknowledgedFailure,
    row.latestHistory,
    row.updatedAt,
  );
  useEffect(() => {
    if (!permission.allowed || !attention || seen.current.has(attention)) return;
    seen.current.add(attention);
    void dispatch({
      environmentId: row.environmentId,
      input: {
        type: "schedule.acknowledge-failures",
        commandId: newCommandId(),
        scheduleId: ScheduleId.make(row.id),
      },
    });
  }, [attention, dispatch, permission.allowed, row.environmentId, row.id]);
  const project = projects.find(
    (p) => p.environmentId === row.environmentId && p.id === row.projectId,
  );
  const provider = environments
    .find((e) => e.environment.environmentId === row.environmentId)
    ?.environment.serverConfig?.providers.find(
      (p) => p.instanceId === row.execution.modelSelection.instanceId,
    );
  const providerMeta = getDriverOption(provider?.driver);
  const ProviderIcon = providerMeta?.icon;
  const tab = route.tab ?? "overview";
  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: row.environmentId, threadId },
    });
  const latest = row.latestHistory;
  return (
    <>
      <PageHeading
        className="schedule-heading"
        title={row.name}
        icon={<CalendarIcon strokeWidth={1.7} />}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <EnvironmentIcon environmentId={row.environmentId} className="size-4" />
            {project?.title ?? "Missing project"} · {row.environmentLabel} ·{" "}
            <span className="capitalize">{row.state}</span>
            {!row.online && " · Offline"}
          </span>
        }
        actions={<ScheduleActions row={row} />}
      />
      {!row.online && (
        <div role="status" className="rounded-lg bg-muted p-4 text-sm">
          <p className="font-medium">{row.environmentLabel} is offline</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Showing the last cached data. Reconnect to edit, run, or load older history.
          </p>
        </div>
      )}
      {row.online && permission.reason && (
        <p role="status" className="text-sm text-muted-foreground">
          {permission.reason}
        </p>
      )}
      <Tabs
        value={tab}
        onValueChange={(value) =>
          void navigate({
            to: "/schedules",
            search: {
              environment: row.environmentId,
              schedule: row.id,
              tab: value === "history" ? "history" : "overview",
            },
          })
        }
      >
        <TabsList className="gap-6" aria-label="Schedule sections">
          <TabsTrigger value="overview" className="data-[active]:font-semibold">
            <LayoutGridIcon className="size-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="history" className="data-[active]:font-semibold">
            <HistoryIcon className="size-4" />
            History
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="space-y-6">
          <div className="grid gap-8 border-b pt-1 pb-5 sm:grid-cols-3">
            <ScheduleStat
              label="Next occurrence"
              icon={<CalendarIcon strokeWidth={1.7} />}
              value={
                row.state !== "enabled"
                  ? row.state.charAt(0).toUpperCase() + row.state.slice(1)
                  : row.nextOccurrenceAt
                    ? scheduleDisplayTimestamp(row.nextOccurrenceAt, row.timeZone)
                    : "Unavailable"
              }
              description={row.state === "paused" ? "No upcoming occurrences" : row.timeZone}
            />
            <ScheduleStat
              label="Repeats"
              icon={<RepeatIcon />}
              value={scheduleRepeatSummary(row.timing, row.timeZone).value}
              description={scheduleRepeatSummary(row.timing, row.timeZone).description}
            />
            <ScheduleStat
              label="Last occurrence"
              icon={<HistoryIcon />}
              value={
                latest
                  ? latest.type === "triggered"
                    ? "Triggered"
                    : latest.type === "failed"
                      ? "Failed"
                      : "Skipped"
                  : "Not yet triggered"
              }
              description={
                latest
                  ? scheduleDisplayTimestamp(
                      latest.type === "triggered"
                        ? latest.triggeredAt
                        : latest.type === "failed"
                          ? latest.lastFailedAt
                          : latest.lastScheduledFor,
                      row.timeZone,
                    )
                  : "No recorded occurrences"
              }
            />
          </div>
          <section className="space-y-2.5">
            <h2 className="text-sm leading-[22px] font-semibold">Prompt</h2>
            {detail ? (
              <p className="rounded-lg border bg-muted/20 px-5 py-4 text-sm leading-[22px] whitespace-pre-wrap break-words">
                {detail.prompt}
              </p>
            ) : (
              <QueryMessage error={error} refresh={refresh} />
            )}
            <p className="text-xs text-muted-foreground">
              Each occurrence starts a fresh thread. Agent progress and approvals appear in that
              thread.
            </p>
          </section>
          <section className="space-y-3">
            <h2 className="text-sm leading-[22px] font-semibold">Execution</h2>
            <dl className="grid gap-x-5 gap-y-3 sm:grid-cols-3">
              <ExecutionField label="Provider & model">
                <span className="flex items-center gap-2">
                  {ProviderIcon && <ProviderIcon className="size-4 shrink-0" />}
                  {provider?.displayName ??
                    providerMeta?.label ??
                    row.execution.modelSelection.instanceId}{" "}
                  ·{" "}
                  {provider?.models.find(
                    (model) => model.slug === row.execution.modelSelection.model,
                  )?.name ?? row.execution.modelSelection.model}
                </span>
              </ExecutionField>
              <ExecutionField label="Permissions">
                {
                  {
                    "full-access": "Full access",
                    "approval-required": "Approval required",
                    "auto-accept-edits": "Auto-accept edits",
                    auto: "Auto",
                  }[row.execution.runtimeMode]
                }
              </ExecutionField>
              <ExecutionField label="Interaction">
                {row.execution.interactionMode === "plan" ? "Plan" : "Build"}
              </ExecutionField>
              <ExecutionField label="Workspace">
                {row.execution.workspaceMode === "worktree"
                  ? "New worktree"
                  : "Shared project workspace"}
              </ExecutionField>
              <ExecutionField label="Base branch">
                {row.execution.baseBranch ?? "Not applicable"}
              </ExecutionField>
              <ExecutionField label="Environment">
                <span className="flex items-center gap-2">
                  <EnvironmentIcon environmentId={row.environmentId} className="size-4" />
                  {row.environmentLabel} · {row.online ? "Online" : "Offline"}
                </span>
              </ExecutionField>
            </dl>
          </section>
          {row.state === "failed" && (
            <p role="status" className="rounded-lg border border-destructive/30 p-4 text-sm">
              The last trigger failed. Inspect History, run again now, or edit a one-time schedule
              to a future time to re-enable it.
            </p>
          )}
          <section>
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-sm leading-[22px] font-semibold">Recent history</h2>
              <Button
                variant="ghost"
                size="sm"
                className="schedule-history-link text-muted-foreground"
                onClick={() =>
                  void navigate({
                    to: "/schedules",
                    search: { environment: row.environmentId, schedule: row.id, tab: "history" },
                  })
                }
              >
                View all history →
              </Button>
            </div>
            {detail ? (
              <ScheduleHistoryTable
                entries={detail.history.slice(-2)}
                timeZone={row.timeZone}
                onOpenThread={openThread}
                compact
              />
            ) : (
              <QueryMessage error={error} refresh={refresh} />
            )}
          </section>
          <div className="flex flex-wrap items-center gap-5">
            <ScheduleActions row={row} lifecycleOnly />
            <p className="text-xs text-muted-foreground">
              {row.state === "paused"
                ? "Resuming starts at the next future time. The paused period is not caught up."
                : `Runs on ${row.environmentLabel} even when Phoenix clients are closed.`}
            </p>
          </div>
        </TabsContent>
        <TabsContent value="history">
          {detail ? (
            <ScheduleHistory
              key={detail.id}
              detail={detail}
              environmentId={row.environmentId}
              online={row.online}
              timeZone={row.timeZone}
              onOpenThread={openThread}
            />
          ) : (
            <QueryMessage error={error} refresh={refresh} />
          )}
        </TabsContent>
      </Tabs>
    </>
  );
}
function QueryMessage({ error, refresh }: { error: string | null; refresh: () => void }) {
  return (
    <div
      role={error ? "alert" : "status"}
      className="flex items-center gap-3 py-5 text-sm text-muted-foreground"
    >
      {error ?? "Loading schedule details…"}
      {error && (
        <Button variant="outline" size="sm" onClick={refresh}>
          Try again
        </Button>
      )}
    </div>
  );
}
function ScheduleStat({
  label,
  icon,
  value,
  description,
}: {
  label: string;
  icon: ReactNode;
  value: string;
  description: string;
}) {
  return (
    <dl className="space-y-1.5">
      <dt className="flex items-center gap-2 text-xs text-muted-foreground [&_svg]:size-4">
        {icon}
        {label}
      </dt>
      <dd className="text-2xl leading-9 font-semibold">{value}</dd>
      <dd className="text-xs text-muted-foreground">{description}</dd>
    </dl>
  );
}
function ExecutionField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-[3px]">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-[13px] leading-[22px] break-words">{children}</dd>
    </div>
  );
}

function draftFromDetail(
  source: AggregatedScheduleRow,
  detail: ScheduleDetail,
  duplicate: boolean,
): ScheduleEditorDraft {
  return {
    ...emptyDraft(source.environmentId),
    name: `${source.name}${duplicate ? " copy" : ""}`,
    prompt: detail.prompt,
    projectId: source.projectId,
    timingType: source.timing.type,
    runAt:
      source.timing.type === "one-time"
        ? (scheduleWallTimeInputForInstant(source.timing.runAt, source.timeZone) ??
          source.timing.runAt)
        : defaultScheduleOneTimeInput(Date.now()),
    cron: source.timing.type === "cron" ? source.timing.expression : "0 9 * * 1-5",
    timeZone: source.timeZone,
    modelSelection: source.execution.modelSelection,
    runtimeMode: source.execution.runtimeMode,
    interactionMode: source.execution.interactionMode,
    workspaceMode: source.execution.workspaceMode,
    workspaceCustomized: true,
    baseBranch: source.execution.baseBranch ?? "origin/HEAD",
    createPaused: duplicate && source.state === "paused",
  };
}
function ScheduleEditorJourney({
  source,
  detail,
  editing,
  duplicating,
  environments,
  onBack,
}: {
  source: AggregatedScheduleRow | undefined;
  detail: ScheduleDetail | null;
  editing: boolean;
  duplicating: boolean;
  environments: ReturnType<typeof useWebEnvironmentSchedules>["environments"];
  onBack: () => void;
}) {
  const key =
    editing || duplicating
      ? `${editing ? "edit" : "duplicate"}:${source?.environmentId}:${source?.id}`
      : "create";
  const [draft, setDraft] = useState(
    () =>
      retainedDrafts.get(key) ??
      (source && detail && (editing || duplicating)
        ? draftFromDetail(source, detail, duplicating)
        : emptyDraft(
            environments.find((e) => e.online && e.supportsSchedules)?.environment.environmentId,
          )),
  );
  const projects = useProjects();
  const navigate = useNavigate();
  const dispatch = useAtomCommand(scheduleEnvironment.dispatch);
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  useEffect(() => {
    retainedDrafts.set(key, draft);
    if (retainedDrafts.size > 24) retainedDrafts.delete(retainedDrafts.keys().next().value!);
  }, [key, draft]);
  useEffect(() => {
    const first = environments.find((e) => e.online && e.supportsSchedules);
    if (!draft.environmentId && first)
      setDraft((current) => ({ ...current, environmentId: first.environment.environmentId }));
  }, [draft.environmentId, environments]);
  const environment = environments.find((e) => e.environment.environmentId === draft.environmentId);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (lock.current) return;
    if (!environment) {
      setError("Choose an available environment.");
      return;
    }
    if (!draft.modelSelection) {
      setError(
        "Choose a provider and model. If none are available, configure a provider on this environment first.",
      );
      return;
    }
    setError(null);
    const one =
      draft.timingType === "one-time" ? zonedWallTimeToInstant(draft.runAt, draft.timeZone) : null;
    const unchangedTime =
      editing && source?.timing.type === "one-time" && one?.instant === source.timing.runAt;
    if (!draft.name.trim() || !draft.prompt.trim() || !draft.projectId) {
      setError("Enter a name and prompt, and choose a project.");
      return;
    }
    if (
      one &&
      (!one.valid || !one.instant || (!unchangedTime && Date.parse(one.instant) <= Date.now()))
    ) {
      setError(one.error ?? "Choose a date and time in the future.");
      return;
    }
    if (draft.timingType === "cron") {
      const result = inspectCronTiming({
        expression: draft.cron,
        timeZone: draft.timeZone,
        after: Date.now(),
      });
      if (!result.valid) {
        setError(result.error ?? "Check the recurring rule.");
        return;
      }
    }
    lock.current = true;
    setPending(true);
    const id = editing && source ? ScheduleId.make(source.id) : ScheduleId.make(randomUUID());
    try {
      const definition = {
        scheduleId: id,
        commandId: newCommandId(),
        projectId: ProjectId.make(draft.projectId),
        name: draft.name.trim(),
        prompt: draft.prompt.trim(),
        timing:
          draft.timingType === "cron"
            ? { type: "cron" as const, expression: draft.cron.trim() }
            : { type: "one-time" as const, runAt: one!.instant! },
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
      const result = await dispatch({
        environmentId: environment.environment.environmentId,
        input: editing
          ? { ...definition, type: "schedule.update" }
          : {
              ...definition,
              type: "schedule.create",
              state: draft.createPaused ? "paused" : "enabled",
            },
      });
      if (result._tag === "Failure") {
        setError(
          "The environment could not save this schedule. Your input is retained. Check your connection and permissions, then try again.",
        );
        return;
      }
      retainedDrafts.delete(key);
      toastManager.add({
        type: "success",
        title: editing ? "Schedule updated" : "Schedule created",
      });
      await navigate({
        to: "/schedules",
        search: {
          environment: environment.environment.environmentId,
          schedule: id,
          tab: "overview",
        },
      });
    } catch {
      setError("Could not save the schedule. Your input is retained; try again.");
    } finally {
      lock.current = false;
      setPending(false);
    }
  };
  return (
    <>
      <PageHeading
        className="schedule-heading"
        title={editing ? "Edit schedule" : duplicating ? "Duplicate schedule" : "Create schedule"}
        icon={<CalendarIcon strokeWidth={1.7} />}
        actions={
          <Button variant="ghost" className="w-fit px-0" disabled={pending} onClick={onBack}>
            <ArrowLeftIcon className="size-4" />
            Back · Keep draft
          </Button>
        }
        description="Run a saved prompt once or on a recurring cadence."
      />
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 p-4 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {environment ? (
        <PermissionEditor
          key={environment.environment.environmentId}
          environment={environment}
          draft={draft}
          editing={editing}
          environments={environments}
          projects={projects}
          pending={pending}
          onChange={setDraft}
          onCancel={() => setDiscard(true)}
          onSubmit={save}
        />
      ) : (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            This draft's environment is unavailable. Choose another destination or cancel to discard
            the draft.
          </p>
          <ScheduleEditor
            draft={draft}
            editing={editing}
            environments={environments}
            projects={projects}
            pending={pending}
            canSave={false}
            onChange={setDraft}
            onCancel={() => setDiscard(true)}
            onSubmit={save}
          />
        </>
      )}
      <Dialog open={discard} onOpenChange={setDiscard}>
        <DialogPopup className="schedule-surface sm:max-w-[430px]" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Discard this draft?</DialogTitle>
            <DialogDescription>
              Your unsaved changes will be removed. The saved schedule will stay unchanged.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscard(false)}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                retainedDrafts.delete(key);
                onBack();
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
function PermissionEditor({
  environment,
  ...props
}: Omit<ComponentProps<typeof ScheduleEditor>, "canSave"> & {
  environment: ReturnType<typeof useWebEnvironmentSchedules>["environments"][number];
}) {
  const permission = useSchedulePermission({
    environmentId: environment.environment.environmentId,
    online: environment.online,
    supportsSchedules: environment.supportsSchedules,
  });
  return (
    <>
      {permission.reason && (
        <p role="status" className="mb-4 text-sm text-muted-foreground">
          {permission.reason}
        </p>
      )}
      <ScheduleEditor
        {...props}
        canSave={permission.allowed}
        onSubmit={(event) => {
          if (!permission.allowed) {
            event.preventDefault();
            return;
          }
          props.onSubmit(event);
        }}
      />
    </>
  );
}
