import {
  type AutopilotCommands,
  autopilotActions,
  autopilotDetail,
  autopilotTimeline,
  batchConfirmText,
  outOfOfficeLabel,
  pauseSend,
  resumeSend,
  runBatch,
  type SalesBatchState,
  type SalesBatchVerb,
  showsOnRowAfterBatch,
} from "@t3tools/client-runtime/sales/autopilot";
import type { SalesHoldOutcome } from "@t3tools/client-runtime/sales/hold";
import { salesDay, salesTime } from "@t3tools/client-runtime/sales/time";
import type { EnvironmentId, SalesAutopilotItem } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useNowMs } from "../../hooks/useNowMinute";
import { salesEnvironment, useSalesView } from "../../state/sales";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { SalesOutcomeAlert } from "./SalesOutcomeAlert";
import { SalesContactLine, SalesViewFrame } from "./SalesViewFrame";
import { useRowActions } from "./useRowActions";

/** Today's sends the engine makes by itself, done and to come, with Pause and Resume on each. */
export function SalesAutopilot(props: {
  readonly environmentId: EnvironmentId;
  readonly canAct: boolean;
}) {
  const { environmentId, canAct } = props;
  const { read, failed } = useSalesView(environmentId, "autopilot");
  const [includePressed, setIncludePressed] = useState(false);
  const now = useNowMs();
  const commands = useAutopilotCommands(environmentId);
  const rows = useRowActions<SalesHoldOutcome>();
  const [batch, setBatch] = useState<SalesBatchState | null>(null);

  const act = (
    item: SalesAutopilotItem,
    verb: SalesBatchVerb,
    keep?: (outcome: SalesHoldOutcome) => boolean,
  ) =>
    rows.run(
      item.activityId,
      item.state,
      () => (verb === "Paused" ? pauseSend : resumeSend)(commands, item.activityId),
      keep,
    );

  const runAll = async (items: ReadonlyArray<SalesAutopilotItem>, verb: SalesBatchVerb) => {
    if ((await requestConfirmDialog(batchConfirmText(verb, items.length))) !== true) return;
    await runBatch(verb, items, (item) => act(item, verb, showsOnRowAfterBatch), setBatch);
  };

  return (
    <SalesViewFrame
      title="Autopilot"
      read={read}
      failed={failed}
      description={(today) => (today.day ? `Today, ${salesDay(today.day)}` : "Today")}
      actions={
        <Label>
          <Switch size="sm" checked={includePressed} onCheckedChange={setIncludePressed} />
          Include approved by you
        </Label>
      }
    >
      {(today) => {
        const timeline = autopilotTimeline(today.items, includePressed);
        const pausable = today.items.filter((item) => autopilotActions(item).pause);
        const paused = today.items.filter((item) => autopilotActions(item).resume);
        const running = batch?.running ?? false;
        return (
          <div className="space-y-6">
            {canAct && (pausable.length > 0 || paused.length > 0 || batch !== null) ? (
              <div className="flex flex-wrap items-center gap-2">
                {pausable.length > 0 ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={running}
                    onClick={() => void runAll(pausable, "Paused")}
                  >
                    Pause all {pausable.length} scheduled
                  </Button>
                ) : null}
                {paused.length > 0 ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={running}
                    onClick={() => void runAll(paused, "Resumed")}
                  >
                    Resume all {paused.length} paused
                  </Button>
                ) : null}
                {batch ? (
                  <p className="text-xs text-muted-foreground" aria-live="polite">
                    {batch.text}
                  </p>
                ) : null}
              </div>
            ) : null}
            {timeline.groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {timeline.pressedHidden > 0
                  ? `No automated sends today. ${timeline.pressedHidden} you approved ${timeline.pressedHidden === 1 ? "is" : "are"} hidden.`
                  : "Nothing goes out today."}
              </p>
            ) : null}
            {timeline.groups.map((group) => (
              <section key={group.state} aria-label={group.label} className="space-y-2">
                <h2 className="text-sm font-medium">
                  {group.label}{" "}
                  <span className="text-muted-foreground tabular-nums">{group.items.length}</span>
                </h2>
                <ul className="divide-y rounded-lg border">
                  {group.items.map((item) => (
                    <AutopilotRow
                      key={item.activityId}
                      environmentId={environmentId}
                      item={item}
                      now={now}
                      canAct={canAct && !running}
                      busy={rows.busy(item.activityId)}
                      outcome={rows.outcome(item.activityId, item.state)}
                      onAct={(verb) => void act(item, verb)}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        );
      }}
    </SalesViewFrame>
  );
}

function useAutopilotCommands(environmentId: EnvironmentId): AutopilotCommands {
  const hold = useAtomCommand(salesEnvironment.hold, { reportFailure: false });
  const resume = useAtomCommand(salesEnvironment.resume, { reportFailure: false });
  const getQueueItem = useAtomCommand(salesEnvironment.getQueueItem, { reportFailure: false });
  return {
    hold: (activityId) => hold({ environmentId, input: { activityId } }),
    resume: (input) => resume({ environmentId, input }),
    getQueueItem: (activityId) => getQueueItem({ environmentId, input: { activityId } }),
  };
}

/** One send, with Pause or Resume where the engine allows it and the engine's last answer. */
function AutopilotRow(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SalesAutopilotItem;
  readonly now: number;
  readonly canAct: boolean;
  readonly busy: boolean;
  readonly outcome: SalesHoldOutcome | null;
  readonly onAct: (verb: SalesBatchVerb) => void;
}) {
  const { item, outcome } = props;
  const at = salesTime(item.at, props.now, { theirZone: item.contact.effectiveTimeZone });
  const detail = autopilotDetail(item);
  const actions = autopilotActions(item);
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex gap-4">
        <div className="w-24 shrink-0 text-sm tabular-nums">
          {at ? (
            <>
              <p>{at.local}</p>
              {at.theirs ? <p className="text-xs text-muted-foreground">{at.theirs}</p> : null}
            </>
          ) : (
            <p className="text-muted-foreground">Soon</p>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <SalesContactLine contact={item.contact} />
            {item.outOfOffice ? (
              <Badge variant="info" title={item.outOfOffice.window || undefined}>
                {outOfOfficeLabel(item.outOfOffice)}
              </Badge>
            ) : null}
          </div>
          {detail ? <p className="truncate text-xs text-muted-foreground">{detail}</p> : null}
          {item.reason ? <p className="text-xs text-muted-foreground">{item.reason}</p> : null}
        </div>
        {props.canAct && (actions.pause || actions.resume) ? (
          <Button
            size="xs"
            variant="outline"
            className="shrink-0 self-center"
            disabled={props.busy}
            onClick={() => props.onAct(actions.pause ? "Paused" : "Resumed")}
          >
            {actions.pause
              ? props.busy
                ? "Pausing…"
                : "Pause"
              : props.busy
                ? "Resuming…"
                : "Resume"}
          </Button>
        ) : null}
      </div>
      {outcome ? (
        <SalesOutcomeAlert outcome={outcome}>
          {outcome.needsPress ? (
            <>
              {" "}
              <Link
                to="/sales"
                search={{
                  environment: props.environmentId,
                  area: "outreach",
                  item: item.activityId,
                }}
                className="underline"
              >
                Open the draft in Outreach
              </Link>
            </>
          ) : null}
        </SalesOutcomeAlert>
      ) : null}
    </li>
  );
}
