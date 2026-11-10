import { autopilotTimeline } from "@t3tools/client-runtime/sales/autopilot";
import { salesDay, salesTime } from "@t3tools/client-runtime/sales/time";
import type { EnvironmentId, SalesAutopilotItem } from "@t3tools/contracts";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useSalesView } from "../../state/sales";
import { Badge } from "../ui/badge";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { SalesContactLine, SalesViewFrame } from "./SalesViewFrame";

/** Today's sends the engine makes by itself, done and to come. Read-only. */
export function SalesAutopilot({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { read, failed } = useSalesView(environmentId, "autopilot");
  const [includePressed, setIncludePressed] = useState(false);
  const now = Date.parse(`${useNowMinute()}:00Z`);
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
        if (timeline.groups.length === 0) {
          return (
            <p className="text-sm text-muted-foreground">
              {timeline.pressedHidden > 0
                ? `No automated sends today. ${timeline.pressedHidden} you approved ${timeline.pressedHidden === 1 ? "is" : "are"} hidden.`
                : "Nothing goes out today."}
            </p>
          );
        }
        return (
          <div className="space-y-6">
            {timeline.groups.map((group) => (
              <section key={group.state} aria-label={group.label} className="space-y-2">
                <h2 className="text-sm font-medium">
                  {group.label}{" "}
                  <span className="text-muted-foreground tabular-nums">{group.items.length}</span>
                </h2>
                <ul className="divide-y rounded-lg border">
                  {group.items.map((item) => (
                    <AutopilotRow key={item.activityId} item={item} now={now} />
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

/** One send. Hold and resume will sit at the end of this row once the engine offers them. */
function AutopilotRow({ item, now }: { readonly item: SalesAutopilotItem; readonly now: number }) {
  const at = salesTime(item.at, now, { theirZone: item.contact.effectiveTimeZone });
  const detail = [
    item.step === null ? null : `Email ${item.step}`,
    item.campaign,
    item.mailbox ? `from ${item.mailbox}` : null,
    item.approval === "press" ? "approved by you" : null,
  ].filter(Boolean);
  return (
    <li className="flex gap-4 px-4 py-3">
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
              {item.outOfOffice.returnOn
                ? `Away until ${salesDay(item.outOfOffice.returnOn)}`
                : "Out of office"}
            </Badge>
          ) : null}
        </div>
        {detail.length > 0 ? (
          <p className="truncate text-xs text-muted-foreground">{detail.join(" · ")}</p>
        ) : null}
        {item.reason ? <p className="text-xs text-muted-foreground">{item.reason}</p> : null}
      </div>
    </li>
  );
}
