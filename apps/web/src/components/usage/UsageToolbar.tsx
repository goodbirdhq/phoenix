import { EnvironmentId } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import type { UsageChartMetric } from "@t3tools/client-runtime/usage/chart-series";

const PERIODS = [
  { days: 1, label: "Past 24h" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

/** One wrapping toolbar serves desktop and narrow layouts. */
export function UsageToolbar({
  environments,
  environmentId,
  onEnvironmentChange,
  metric,
  onMetricChange,
  days,
  onDaysChange,
  refreshing,
  onRefresh,
}: {
  readonly environments: readonly { environmentId: EnvironmentId; label: string }[];
  readonly environmentId: EnvironmentId | null;
  readonly onEnvironmentChange: (value: EnvironmentId | null) => void;
  readonly metric: UsageChartMetric;
  readonly onMetricChange: (value: UsageChartMetric) => void;
  readonly days: number;
  readonly onDaysChange: (value: number) => void;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={environmentId ?? ""}
        onValueChange={(value) => onEnvironmentChange(value ? EnvironmentId.make(value) : null)}
      >
        <SelectTrigger
          aria-label="Historical usage environment"
          className="w-auto max-w-44"
          size="compact"
        >
          <SelectValue>
            {environments.find((entry) => entry.environmentId === environmentId)?.label ??
              "All environments"}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          <SelectItem value="">All environments</SelectItem>
          {environments.map((entry) => (
            <SelectItem key={entry.environmentId} value={entry.environmentId}>
              {entry.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Select
        value={String(days)}
        onValueChange={(value) => {
          const period = PERIODS.find((entry) => String(entry.days) === value);
          if (period) onDaysChange(period.days);
        }}
      >
        <SelectTrigger aria-label="Usage period" className="w-auto" size="compact">
          <SelectValue>{PERIODS.find((entry) => entry.days === days)?.label}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {PERIODS.map((period) => (
            <SelectItem key={period.days} value={String(period.days)}>
              {period.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <ToggleGroup
        aria-label="Usage metric"
        aria-orientation={undefined}
        variant="segmented"
        value={[metric]}
        onValueChange={(next) => {
          const value = next[0];
          if (value === "cost" || value === "tokens") onMetricChange(value);
        }}
      >
        <Toggle value="cost" className="text-foreground">
          Cost
        </Toggle>
        <Toggle value="tokens" className="text-foreground">
          Tokens
        </Toggle>
      </ToggleGroup>
      <Button
        size="icon-sm"
        variant="outline"
        onClick={onRefresh}
        aria-label="Refresh usage"
        aria-busy={refreshing || undefined}
      >
        <RefreshCwIcon className="size-3.5" />
      </Button>
    </div>
  );
}
