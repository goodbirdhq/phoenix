import { useState } from "react";
import { CheckIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "../ui/button";

/** Keeps completion visible after the request settles without claiming fresh provider data. */
export function UsageRefreshButton({
  refreshing,
  onRefresh,
  label,
  disabledReason,
}: {
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly label: string;
  readonly disabledReason?: string | undefined;
}) {
  const [previousRefreshing, setPreviousRefreshing] = useState(refreshing);
  const [checked, setChecked] = useState(false);
  if (previousRefreshing !== refreshing) {
    setPreviousRefreshing(refreshing);
    setChecked(!refreshing);
  }
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={refreshing || !!disabledReason}
      title={disabledReason}
      aria-label={label}
      aria-busy={refreshing || undefined}
      onClick={() => {
        setChecked(false);
        onRefresh();
      }}
    >
      {checked && !disabledReason ? (
        <CheckIcon className="size-3.5" />
      ) : (
        <RefreshCwIcon className="size-3.5" />
      )}
      <span role="status">
        {refreshing ? "Checking…" : checked && !disabledReason ? "Checked" : label}
      </span>
    </Button>
  );
}
