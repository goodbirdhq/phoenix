import { useState } from "react";
import { CheckIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "../ui/button";

/** Only a click on this control can produce completion feedback. */
export function UsageRefreshButton({
  refreshing,
  onRefresh,
  label,
  disabledReason,
  confirmed = true,
  compact = false,
}: {
  readonly refreshing: boolean;
  readonly compact?: boolean;
  readonly confirmed?: boolean | undefined;
  readonly onRefresh: () => void;
  readonly label: string;
  readonly disabledReason?: string | undefined;
}) {
  const [previousRefreshing, setPreviousRefreshing] = useState(refreshing);
  const [requested, setRequested] = useState(false);
  const [checked, setChecked] = useState<"confirmed" | "unconfirmed" | null>(null);
  if (previousRefreshing !== refreshing) {
    setPreviousRefreshing(refreshing);
    if (requested && !refreshing) {
      setChecked(confirmed ? "confirmed" : "unconfirmed");
      setRequested(false);
    }
  }
  return (
    <Button
      size="sm"
      className={compact ? "size-9 shrink-0 p-0" : undefined}
      variant="outline"
      disabled={refreshing || !!disabledReason}
      aria-description={disabledReason}
      aria-label={label}
      aria-busy={refreshing || undefined}
      onClick={() => {
        setRequested(true);
        setChecked(null);
        onRefresh();
      }}
    >
      {checked === "confirmed" && !disabledReason ? (
        <CheckIcon className="size-3.5" />
      ) : (
        <RefreshCwIcon className="size-3.5" />
      )}
      <span role="status" className={compact ? "sr-only" : undefined}>
        {refreshing
          ? "Checking…"
          : checked && !disabledReason
            ? checked === "confirmed"
              ? "Checked"
              : "Could not confirm"
            : label}
      </span>
    </Button>
  );
}
