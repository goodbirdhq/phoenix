import { safeHttpUrl } from "@t3tools/client-runtime/sales/links";
import {
  connectionLabel,
  groupTasks,
  inviteBudgetLine,
  taskActionLabel,
  taskDueLabel,
} from "@t3tools/client-runtime/sales/tasks";
import type { EnvironmentId, SalesTask } from "@t3tools/contracts";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useRef } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useSalesView } from "../../state/sales";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "../ui/anchoredCopyToast";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SalesExternalLink } from "./SalesExternalLink";
import { SalesContactLine, SalesViewFrame } from "./SalesViewFrame";

/** The LinkedIn checklist: what to do by hand, and today's invite budget. Read-only. */
export function SalesTodo({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { read, failed } = useSalesView(environmentId, "tasks");
  return (
    <SalesViewFrame
      title="To do"
      read={read}
      failed={failed}
      description={(list) => inviteBudgetLine(list.budget)}
    >
      {(list) => {
        const { ready, upcoming } = groupTasks(list.items);
        if (list.items.length === 0) {
          return <p className="text-sm text-muted-foreground">Nothing to do on LinkedIn.</p>;
        }
        return (
          <div className="space-y-6">
            <TaskSection label="Ready" tasks={ready} today={list.budget.day} />
            <TaskSection label="Not posted yet" tasks={upcoming} today={list.budget.day} />
          </div>
        );
      }}
    </SalesViewFrame>
  );
}

function TaskSection(props: {
  readonly label: string;
  readonly tasks: ReadonlyArray<SalesTask>;
  readonly today: string | null;
}) {
  if (props.tasks.length === 0) return null;
  return (
    <section aria-label={props.label} className="space-y-2">
      <h2 className="text-sm font-medium">
        {props.label}{" "}
        <span className="text-muted-foreground tabular-nums">{props.tasks.length}</span>
      </h2>
      <ul className="divide-y rounded-lg border">
        {props.tasks.map((task) => (
          <TaskRow key={task.id} task={task} today={props.today} />
        ))}
      </ul>
    </section>
  );
}

/** One task. Done and skip will sit at the end of this row once the engine offers them. */
function TaskRow({ task, today }: { readonly task: SalesTask; readonly today: string | null }) {
  const linkedin = safeHttpUrl(task.contact.linkedinUrl);
  const connection = connectionLabel(task.connectionState);
  const due = taskDueLabel(task.dueOn, today);
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
    </li>
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
