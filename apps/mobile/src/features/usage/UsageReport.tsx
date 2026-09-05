import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { buildUsageReport } from "@t3tools/client-runtime/usage/reports";
import type { MergedUsage } from "@t3tools/shared/usageMerge";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";

export function UsageReport({
  mode,
  merged,
}: {
  readonly mode: "projects" | "threads";
  readonly merged: MergedUsage;
}) {
  const rows = useMemo(
    () => buildUsageReport(merged.sessionUsage, mode),
    [merged.sessionUsage, mode],
  );
  const [limit, setLimit] = useState(50);
  return (
    <View className="gap-4">
      <Text className="text-xs text-foreground-muted">
        Selected-period API estimates. Unlinked native history remains unattributed.
      </Text>
      {merged.sessionDetailUnavailable.length > 0 && (
        <Text className="text-xs text-foreground-muted">
          Some environments cannot report session detail. Their totals remain in Overview.
        </Text>
      )}
      {rows.slice(0, limit).map((row) => (
        <View key={row.key} className="gap-2 border-b border-border pb-4">
          <View className="flex-row items-center gap-3">
            {row.project && (
              <ProjectFavicon
                environmentId={row.environmentId}
                workspaceRoot={row.project.projectWorkspaceRoot}
                projectTitle={row.project.projectTitle}
                faviconPath={row.project.projectFaviconPath}
                size={24}
              />
            )}
            <View className="flex-1">
              <Text className="font-t3-medium text-foreground">{row.title}</Text>
              <Text className="text-xs text-foreground-muted">
                {row.environmentLabel}
                {row.attribution === "ambiguous" ? " · Shared history" : ""}
                {mode === "threads" && row.project ? ` · ${row.project.projectTitle}` : ""}
              </Text>
            </View>
            <Text className="text-foreground">{formatUsd(row.costUsd)}</Text>
          </View>
          <Text className="text-xs text-foreground-muted">{row.models.join(", ")}</Text>
          <Text className="text-xs text-foreground-muted">
            {formatTokens(row.totalTokens)} tokens · {row.sessions} sessions
          </Text>
          <Text className="text-xs text-foreground-muted">
            Cache: {formatTokens(row.cachedInputTokens)} read /{" "}
            {formatTokens(row.cacheCreationTokens)} write
            {row.unpricedRecords ? " · Some usage unpriced" : ""}
          </Text>
        </View>
      ))}
      {!rows.length && (
        <Text className="text-sm text-foreground-muted">No session detail for this selection.</Text>
      )}
      {rows.length > limit && (
        <Pressable accessibilityRole="button" onPress={() => setLimit(limit + 50)} className="p-3">
          <Text className="text-center text-primary">Show more</Text>
        </Pressable>
      )}
    </View>
  );
}
