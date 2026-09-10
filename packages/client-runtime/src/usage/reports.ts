import type { EnvironmentId, UsageSessionModel, UsageThread } from "@t3tools/contracts";
import type { EnvironmentSessionUsage } from "@t3tools/shared/usageMerge";

export interface UsageReportRow {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly title: string;
  readonly project: UsageThread | undefined;
  readonly attribution: "linked" | "unlinked" | "ambiguous";
  readonly models: readonly string[];
  readonly sessions: number;
  readonly lastActivityAt: string;
  readonly sessionId: string | undefined;
  readonly totalTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly costUsd: number;
  readonly unpricedRecords: number;
}

function tokens(model: UsageSessionModel): number {
  const totals = model.totals;
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

/** Thread/project identity remains environment-local. Native sessions without
 * a unique recorded link remain visible so the report doesn't lose their cost. */
export function buildUsageReport(
  sessions: readonly EnvironmentSessionUsage[],
  mode: "threads" | "projects" | "sessions",
): readonly UsageReportRow[] {
  const groups = new Map<string, EnvironmentSessionUsage[]>();
  for (const session of sessions) {
    const thread = session.attribution === "linked" ? session.thread : undefined;
    const identity =
      mode === "sessions"
        ? [session.environmentId, "native", session.sourceId, session.provider, session.sessionId]
        : thread
          ? [session.environmentId, "linked", mode === "threads" ? thread.id : thread.projectId]
          : mode === "projects"
            ? [session.environmentId, "unattributed"]
            : [
                session.environmentId,
                "native",
                session.sourceId,
                session.provider,
                session.sessionId,
              ];
    const key = JSON.stringify(identity);
    const group = groups.get(key);
    if (group) group.push(session);
    else groups.set(key, [session]);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const first = group[0]!;
      const project = first.attribution === "linked" ? first.thread : undefined;
      const models = group
        .flatMap((session) => session.models)
        .filter(
          (model) =>
            !["synthetic", "<synthetic>"].includes(model.model.trim().toLowerCase()) ||
            tokens(model) > 0 ||
            model.costUsd > 0,
        );
      return {
        key,
        environmentId: first.environmentId,
        environmentLabel: first.environmentLabel,
        title: project
          ? mode !== "projects"
            ? project.title
            : project.projectTitle
          : mode === "projects"
            ? "Unattributed usage"
            : `Unlinked session · ${first.sessionId.slice(0, 8)}`,
        project,
        attribution: project
          ? ("linked" as const)
          : group.some((session) => session.attribution === "ambiguous")
            ? ("ambiguous" as const)
            : ("unlinked" as const),
        models: [...new Set(models.map((model) => model.model))].sort(),
        sessions: group.length,
        sessionId: mode === "sessions" ? first.sessionId : undefined,
        lastActivityAt: group.reduce(
          (latest, session) => (session.lastActivityAt > latest ? session.lastActivityAt : latest),
          first.lastActivityAt,
        ),
        totalTokens: models.reduce((sum, model) => sum + tokens(model), 0),
        cachedInputTokens: models.reduce((sum, model) => sum + model.totals.cachedInputTokens, 0),
        cacheCreationTokens: models.reduce(
          (sum, model) => sum + model.totals.cacheCreationTokens,
          0,
        ),
        costUsd: models.reduce((sum, model) => sum + model.costUsd, 0),
        unpricedRecords: models.reduce((sum, model) => sum + model.unpricedRecords, 0),
      };
    })
    .filter((row) => row.models.length > 0 || row.attribution === "linked")
    .sort((a, b) => b.costUsd - a.costUsd || a.key.localeCompare(b.key));
}
