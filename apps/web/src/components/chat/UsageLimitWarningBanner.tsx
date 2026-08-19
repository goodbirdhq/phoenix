import {
  formatUsageWarningReset,
  type ThreadUsageWarning,
} from "@t3tools/client-runtime/usage/usage-warning";
import { ProviderDriverKind } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/**
 * One quiet line saying the account this thread runs on is nearly through a
 * usage window. Informational only: `action` is the slot a later hand-off
 * control drops into, and nothing here animates.
 */
export const UsageLimitWarningBanner = memo(function UsageLimitWarningBanner({
  action,
  onDismiss,
  warning,
}: {
  /** Consumed by issue #36's in-flight "hand off now" control. */
  action?: ReactNode;
  onDismiss: () => void;
  warning: ThreadUsageWarning | null;
}) {
  if (!warning) return null;

  const reset = formatUsageWarningReset(warning.resetsAt);
  const percent = Math.round(warning.usedPercent);

  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-2rem)] pt-3">
      <div
        className="alert-glass relative inline-flex items-center gap-2.5 rounded-xl border border-warning/32 py-2 ps-3 pe-9 text-sm text-card-foreground"
        data-variant="warning"
        role="status"
      >
        <ProviderInstanceIcon
          className="shrink-0"
          displayName={warning.accountName}
          driverKind={ProviderDriverKind.make(warning.driver)}
          iconClassName="size-4"
        />
        <div className="min-w-0 truncate">
          <span className="font-medium">{warning.accountName}</span>
          <span className="text-muted-foreground">
            {" is "}
            <span className="tabular-nums">{percent}%</span>
            {" through its "}
            {warning.windowLabel.toLowerCase()}
            {" window"}
            {reset ? ` · resets ${reset}` : ""}
            {warning.isReadingUnconfirmed ? " · last known reading" : ""}
          </span>
        </div>
        {action}
        <Button
          aria-label={`Dismiss ${warning.accountName} usage warning`}
          className="absolute top-1.5 right-1.5 size-6 text-muted-foreground hover:text-foreground"
          onClick={onDismiss}
          size="icon-xs"
          variant="ghost"
        >
          <XIcon aria-hidden className="size-3.5" />
        </Button>
      </div>
    </div>
  );
});
