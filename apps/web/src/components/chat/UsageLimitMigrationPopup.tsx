import { ProviderInstanceId } from "@t3tools/contracts";
import { GaugeIcon } from "lucide-react";
import { memo } from "react";

import { Button } from "../ui/button";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

export interface UsageLimitMigrationTarget {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly model: string;
  readonly remainingQuotaPercent: number | null;
}

export const UsageLimitMigrationPopup = memo(function UsageLimitMigrationPopup(props: {
  readonly originName: string;
  readonly resetLabel: string | null;
  readonly targets: readonly UsageLimitMigrationTarget[];
  readonly selectedTarget: UsageLimitMigrationTarget | null;
  readonly failedTurnCanRetry: boolean;
  readonly retryUnavailableReason: string | null;
  readonly isBulkPending: boolean;
  readonly bulkDisabledReason: string | null;
  readonly onSelectTarget: (instanceId: ProviderInstanceId) => void;
  readonly onSwitchAndRetry: () => void;
  readonly onSwitchOnly: () => void;
  readonly onSwitchAll: () => void;
}) {
  const targetItems = props.targets.map((target) => ({
    value: target.instanceId,
    label: target.displayName,
  }));

  return (
    <section
      data-usage-limit-migration-popup="true"
      className="mx-auto mb-2 w-full max-w-3xl rounded-xl border border-warning/35 bg-popover/96 p-3 text-popover-foreground shadow-lg backdrop-blur-xl sm:p-4"
      aria-labelledby="usage-limit-migration-title"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-warning/12 text-warning-foreground">
          <GaugeIcon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="usage-limit-migration-title" className="font-medium text-sm">
            {props.originName} reached its usage limit
          </h2>
          <p className="mt-0.5 text-muted-foreground text-xs leading-5">
            Move this thread to another provider instance and keep its history in place.
            {props.resetLabel ? ` ${props.resetLabel}.` : ""}
          </p>

          {props.selectedTarget ? (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select
                modal={false}
                value={props.selectedTarget.instanceId}
                onValueChange={(value) =>
                  value && props.onSelectTarget(ProviderInstanceId.make(String(value)))
                }
                items={targetItems}
              >
                <SelectTrigger
                  size="sm"
                  className="min-w-0 flex-1 sm:max-w-64"
                  aria-label="Migration target"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectGroup>
                    <SelectGroupLabel>Switch to</SelectGroupLabel>
                    {props.targets.map((target) => (
                      <SelectItem key={target.instanceId} value={target.instanceId}>
                        <span className="flex min-w-0 items-center justify-between gap-3">
                          <span className="truncate">{target.displayName}</span>
                          <span className="shrink-0 text-muted-foreground text-xs">
                            {target.remainingQuotaPercent === null
                              ? "Quota unknown"
                              : `${target.remainingQuotaPercent}% left`}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectPopup>
              </Select>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={!props.failedTurnCanRetry}
                  title={props.retryUnavailableReason ?? undefined}
                  onClick={props.onSwitchAndRetry}
                >
                  Switch to {props.selectedTarget.displayName} and retry
                </Button>
                <Button size="sm" variant="outline" onClick={props.onSwitchOnly}>
                  Switch only
                </Button>
              </div>
            </div>
          ) : (
            <p className="mt-3 rounded-lg border bg-muted/35 px-3 py-2 text-muted-foreground text-sm">
              No other ready provider instance is available.
            </p>
          )}

          {props.selectedTarget ? (
            <div className="mt-2 border-t pt-2">
              <Button
                size="xs"
                variant="ghost"
                className="-ms-2 text-muted-foreground"
                disabled={props.isBulkPending || props.bulkDisabledReason !== null}
                title={props.bulkDisabledReason ?? undefined}
                onClick={props.onSwitchAll}
              >
                {props.isBulkPending
                  ? "Switching active threads..."
                  : "Switch all active threads on this account"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
});
