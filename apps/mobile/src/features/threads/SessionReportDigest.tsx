import {
  deriveSessionReportInboxChildren,
  deriveSessionReportNotifications,
  visibleSessionReportInboxChildren,
} from "@t3tools/client-runtime/session-report-notifications";
import type { EnvironmentId, OrchestrationThreadActivity } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";

export function SessionReportDigest(props: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly environmentId: EnvironmentId;
}) {
  const navigation = useNavigation();
  const children = useMemo(
    () =>
      visibleSessionReportInboxChildren(
        deriveSessionReportInboxChildren(deriveSessionReportNotifications(props.activities)),
      ),
    [props.activities],
  );
  if (children.length === 0) return null;

  return (
    <View className="pb-2">
      <Text className="px-4 pb-1 font-t3-medium text-xs text-foreground-muted">
        Child report inbox
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-2 px-4"
      >
        {children.map((child) => {
          const failed = child.latest.payload.status === "failure";
          return (
            <Pressable
              key={child.childThreadId}
              accessibilityRole="button"
              accessibilityLabel={`Open ${child.childTitle}: ${child.latest.payload.reportTitle ?? child.latest.summary}`}
              className="max-w-72 flex-row items-center gap-2 rounded-xl border border-adaptive-neutral-300-a60-white-a12 bg-subtle px-3 py-2 active:opacity-70"
              onPress={() =>
                navigation.navigate("Thread", {
                  environmentId: String(props.environmentId),
                  threadId: String(child.childThreadId),
                })
              }
            >
              <SymbolView
                name={failed ? "exclamationmark.triangle" : "doc.text"}
                size={15}
                tintColorClassName={failed ? "accent-adaptive-rose-600-400" : "foreground-muted"}
                type="monochrome"
              />
              <View className="min-w-0 flex-1">
                <Text className="font-t3-medium text-sm text-foreground" numberOfLines={1}>
                  {child.childTitle}
                </Text>
                <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                  {child.latest.payload.reportTitle ?? child.latest.summary}
                  {child.unreadCount > 1 ? ` · ${child.unreadCount} updates` : ""}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
