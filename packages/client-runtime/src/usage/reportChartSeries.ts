import { DateTime } from "effect";
import type { MergedUsage } from "@t3tools/shared/usageMerge";
import type { UsageAccount } from "./accounts.ts";

export interface ReportChartSeries {
  readonly id: string;
  readonly label: string;
  readonly provider: string | null;
  readonly values: readonly number[];
}

/** Creation counts use the creation stream, including zero-usage threads. */
export function usageReportSeries(
  merged: MergedUsage,
  accounts: readonly UsageAccount[],
  periods: readonly string[],
  mode: "projects" | "threads" | "sessions",
  metric: "cost" | "tokens",
  timeZone: string,
  byProvider: boolean,
): readonly ReportChartSeries[] {
  const groups = new Map<
    string,
    { id: string; label: string; provider: string | null; values: number[] }
  >();
  const indexByPeriod = new Map(periods.map((period, index) => [period, index]));
  const add = (
    id: string,
    label: string,
    provider: string | null,
    period: string,
    amount: number,
  ) => {
    const index = indexByPeriod.get(period);
    if (index === undefined) return;
    let row = groups.get(id);
    if (!row) {
      row = { id, label, provider, values: periods.map(() => 0) };
      groups.set(id, row);
    }
    row.values[index]! += amount;
  };
  if (mode === "projects") {
    for (const session of merged.sessionUsage) {
      const project = session.attribution === "linked" ? session.thread : undefined;
      const key = JSON.stringify([session.environmentId, project?.projectId ?? "unattributed"]);
      for (const period of session.periods ?? [])
        add(
          key,
          project
            ? `${project.projectTitle} · ${session.environmentLabel}`
            : `Unattributed · ${session.environmentLabel}`,
          session.provider,
          period.period,
          metric === "cost" ? period.costUsd : period.totalTokens,
        );
    }
  } else if (mode === "sessions") {
    for (const session of merged.sessionUsage) {
      for (const period of session.periods ?? []) {
        add(
          byProvider ? session.provider : "total",
          byProvider ? session.provider : "Active sessions",
          byProvider ? session.provider : null,
          period.period,
          1,
        );
      }
    }
  } else {
    const byMember = new Map(
      accounts.flatMap((account) =>
        account.memberships.map(
          (member) =>
            [
              JSON.stringify([member.environmentId, member.provider.instanceId]),
              String(account.driver),
            ] as const,
        ),
      ),
    );
    const toDay = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const hourly = periods[0]?.includes("T") === true;
    const start = hourly ? Date.parse(periods[0]!) : 0;
    for (const creation of merged.threadCreations) {
      const driver = byMember.get(JSON.stringify([creation.environmentId, creation.instanceId]));
      const provider = driver === "claudeAgent" ? "claude" : (driver ?? null);
      const instant = Date.parse(creation.createdAt);
      if (!Number.isFinite(instant)) continue;
      const period = hourly
        ? DateTime.formatIso(
            DateTime.makeUnsafe(start + Math.floor((instant - start) / 3600000) * 3600000),
          )
        : toDay.format(instant);
      add(
        byProvider ? (provider ?? "unknown") : "total",
        byProvider ? (provider ?? "Unknown provider") : "Sessions created",
        byProvider ? provider : null,
        period,
        1,
      );
    }
  }
  return groups.size
    ? [...groups.values()]
    : [
        {
          id: "empty",
          label:
            mode === "threads"
              ? "Sessions created"
              : mode === "sessions"
                ? "Active sessions"
                : "Usage",
          provider: null,
          values: periods.map(() => 0),
        },
      ];
}
