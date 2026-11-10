import { safeHttpsUrl } from "@t3tools/client-runtime/sales/links";
import type { RowActions } from "@t3tools/client-runtime/sales/row-actions";
import {
  connectionLabel,
  groupTasks,
  inviteBudgetLine,
  markSentLabel,
  type SalesTaskReportOutcome,
  shownBudget,
  taskActionLabel,
  taskDueLabel,
  taskOutcomeChoices,
  taskOutcomeLabel,
  taskReportOutcome,
} from "@t3tools/client-runtime/sales/tasks";
import type {
  EnvironmentId,
  SalesTask,
  SalesTaskBudget,
  SalesTaskOutcome,
} from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, CopyIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { salesEnvironment, useSalesView } from "../../state/sales";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "../ui/anchoredCopyToast";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SalesExternalLink } from "./SalesExternalLink";
import { SalesOutcomeAlert } from "./SalesOutcomeAlert";
import { SalesContactLine, SalesViewFrame } from "./SalesViewFrame";
import { useRowActions } from "./useRowActions";

interface TaskReporting {
  readonly canAct: boolean;
  readonly rows: RowActions<SalesTaskReportOutcome>;
  readonly report: (task: SalesTask, outcome: SalesTaskOutcome) => void;
}

/**
 * The LinkedIn checklist: what to do by hand, with each outcome reported to the engine as a
 * press on its Slack card would, and today's invite budget. Tasks not posted yet are a backlog
 * waiting for budget, kept out of the way.
 */
export function SalesTodo(props: {
  readonly environmentId: EnvironmentId;
  readonly canAct: boolean;
}) {
  const { environmentId } = props;
  const { read, failed } = useSalesView(environmentId, "tasks");
  const reportTask = useAtomCommand(salesEnvironment.reportTask, { reportFailure: false });
  const rows = useRowActions<SalesTaskReportOutcome>();
  /** The budget the last report returned, for the list it was reported against. */
  const [reported, setReported] = useState<{
    readonly budget: SalesTaskBudget;
    readonly listGeneratedAt: string;
  } | null>(null);

  const report = async (task: SalesTask, outcome: SalesTaskOutcome) => {
    const listGeneratedAt = read?.data?.generatedAt ?? "";
    const result = await rows.run(task.id, task.status, async () =>
      taskReportOutcome(
        outcome,
        await reportTask({ environmentId, input: { taskId: task.id, outcome } }),
      ),
    );
    if (result.budget !== null) setReported({ budget: result.budget, listGeneratedAt });
  };
  const reporting: TaskReporting = {
    canAct: props.canAct,
    rows,
    report: (task, outcome) => void report(task, outcome),
  };

  return (
    <SalesViewFrame
      title="To do"
      read={read}
      failed={failed}
      description={(list) => inviteBudgetLine(shownBudget(list, reported))}
    >
      {(list) => {
        const { ready, waiting } = groupTasks(list.items);
        if (list.items.length === 0) {
          return <p className="text-sm text-muted-foreground">Nothing to do on LinkedIn.</p>;
        }
        return (
          <div className="space-y-6">
            {ready.length > 0 ? (
              <section aria-label="Ready" className="space-y-2">
                <h2 className="text-sm font-medium">
                  Ready <span className="text-muted-foreground tabular-nums">{ready.length}</span>
                </h2>
                <TaskList tasks={ready} today={list.budget.day} reporting={reporting} />
              </section>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing is ready to do right now.</p>
            )}
            {waiting.length > 0 ? <WaitingTasks tasks={waiting} reporting={reporting} /> : null}
          </div>
        );
      }}
    </SalesViewFrame>
  );
}

/** The backlog, folded: it waits on the invite budget, not on the person, so it is never overdue. */
function WaitingTasks(props: {
  readonly tasks: ReadonlyArray<SalesTask>;
  readonly reporting: TaskReporting;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Waiting for invite budget" className="space-y-2">
      <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDownIcon className={open ? undefined : "-rotate-90"} />
        {props.tasks.length} waiting for invite budget
      </Button>
      {open ? <TaskList tasks={props.tasks} today={null} reporting={props.reporting} /> : null}
    </section>
  );
}

function TaskList(props: {
  readonly tasks: ReadonlyArray<SalesTask>;
  /** The engine's today, for due dates; null leaves them out. */
  readonly today: string | null;
  readonly reporting: TaskReporting;
}) {
  return (
    <ul className="divide-y rounded-lg border">
      {props.tasks.map((task) => (
        <TaskRow key={task.id} task={task} today={props.today} reporting={props.reporting} />
      ))}
    </ul>
  );
}

function TaskRow(props: {
  readonly task: SalesTask;
  readonly today: string | null;
  readonly reporting: TaskReporting;
}) {
  const { task, reporting } = props;
  const linkedin = safeHttpsUrl(task.contact.linkedinUrl);
  const connection = connectionLabel(task.connectionState);
  const due = props.today === null ? null : taskDueLabel(task.dueOn, props.today);
  const outcome = reporting.rows.outcome(task.id, task.status);
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge variant="outline">{taskActionLabel(task.action)}</Badge>
        <SalesContactLine contact={task.contact} />
        {linkedin ? <SalesExternalLink href={linkedin}>LinkedIn</SalesExternalLink> : null}
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {task.frontOfQueue ? <span>First in line</span> : null}
          {connection ? <span>{connection}</span> : null}
          {due ? <span>{due}</span> : null}
        </span>
      </div>
      {task.suggestedText ? <SuggestedText text={task.suggestedText} /> : null}
      {reporting.canAct ? (
        <TaskOutcomes
          task={task}
          busy={reporting.rows.busy(task.id)}
          onReport={(chosen) => reporting.report(task, chosen)}
        />
      ) : null}
      {outcome ? <SalesOutcomeAlert outcome={outcome} /> : null}
    </li>
  );
}

/**
 * The outcomes the engine takes for this task: "Mark sent to Ana" first where offered, a second
 * single choice as its own button, more in a menu. Marking sent spends an invite for good, so its
 * button names whose; it asks nothing more.
 */
function TaskOutcomes(props: {
  readonly task: SalesTask;
  readonly busy: boolean;
  readonly onReport: (outcome: SalesTaskOutcome) => void;
}) {
  const { primary, others } = taskOutcomeChoices(props.task);
  const [only] = others.length === 1 ? others : [];
  if (primary === null && others.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {primary ? (
        <Button size="xs" disabled={props.busy} onClick={() => props.onReport(primary)}>
          {props.busy ? "Reporting…" : markSentLabel(props.task)}
        </Button>
      ) : null}
      {only ? (
        <Button
          size="xs"
          variant="outline"
          disabled={props.busy}
          onClick={() => props.onReport(only)}
        >
          {taskOutcomeLabel(only)}
        </Button>
      ) : others.length > 1 ? (
        <Menu>
          <MenuTrigger render={<Button size="xs" variant="outline" />} disabled={props.busy}>
            {primary ? "Something else" : "Report"}
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup align="start">
            {others.map((outcome) => (
              <MenuItem key={outcome} onClick={() => props.onReport(outcome)}>
                {taskOutcomeLabel(outcome)}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}

function SuggestedText({ text }: { readonly text: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
  });
  return (
    <div className="flex items-start gap-2 rounded-md bg-muted/40 p-2">
      <p className="min-w-0 flex-1 text-sm whitespace-pre-wrap">{text}</p>
      <Button
        ref={ref}
        size="icon-xs"
        variant="ghost"
        aria-label="Copy the suggested text"
        onClick={() => copyToClipboard(text, undefined)}
      >
        {isCopied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}
