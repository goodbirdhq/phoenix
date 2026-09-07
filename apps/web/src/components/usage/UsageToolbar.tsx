import { EnvironmentId } from "@t3tools/contracts";
import { UsageRefreshButton } from "./UsageRefreshButton";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const PERIODS = [
  { days: 1, label: "Past 24h" },
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
];

/** One wrapping toolbar serves desktop and narrow layouts. */
export function UsageToolbar({
  environments,
  environmentId,
  onEnvironmentChange,
  days,
  onDaysChange,
  refreshing,
  confirmed,
  onRefresh,
}: {
  readonly environments: readonly { environmentId: EnvironmentId; label: string }[];
  readonly environmentId: EnvironmentId | null;
  readonly onEnvironmentChange: (value: EnvironmentId | null) => void;
  readonly days: number;
  readonly onDaysChange: (value: number) => void;
  readonly refreshing: boolean;
  readonly confirmed?: boolean;
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
      <UsageRefreshButton
        compact
        label="Refresh usage"
        confirmed={confirmed}
        refreshing={refreshing}
        onRefresh={onRefresh}
      />
    </div>
  );
}
