import { useState } from "react";
import { CheckIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "../ui/button";

/** Keeps completion visible after the request settles without claiming fresh provider data. */
export function UsageRefreshButton({
  refreshing,
  onRefresh,
  label,
}: {
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly label: string;
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
      disabled={refreshing}
      aria-label={label}
      aria-busy={refreshing || undefined}
      onClick={() => {
        setChecked(false);
        onRefresh();
      }}
    >
      {checked ? <CheckIcon className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
      <span role="status">{refreshing ? "Checking…" : checked ? "Checked" : label}</span>
    </Button>
  );
}
