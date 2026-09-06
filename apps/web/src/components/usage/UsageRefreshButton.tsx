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
}: {
  readonly refreshing: boolean;
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
      <span role="status">
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
