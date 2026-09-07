import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useMemo } from "react";
import { Pressable, View } from "react-native";
import { ThreadAvatar, threadIdentityLabel } from "../../components/ThreadAvatar";
import { AppText } from "../../components/AppText";
import { useNavigationColors } from "../../components/useNavigationColors";
import { useServerConfigs } from "../../state/entities";
import { buildThreadAgentGroupHierarchy, type ThreadAgentGroupNode } from "./threadListV2";

const MAX_AGENT_GROUP_INDENT = 4;

export function ThreadAgentGroup({
  threads,
  expanded,
  onToggle,
  onSelect,
  detail = false,
}: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (thread: EnvironmentThreadShell) => void;
  detail?: boolean;
}) {
  const configs = useServerConfigs();
  const colors = useNavigationColors();
  const driver = (thread: EnvironmentThreadShell) =>
    configs
      .get(thread.environmentId)
      ?.providers.find(
        (p) =>
          p.instanceId === (thread.session?.providerInstanceId ?? thread.modelSelection.instanceId),
      )?.driver ?? null;
  const hierarchy = useMemo(
    () => (detail && expanded ? buildThreadAgentGroupHierarchy(threads) : []),
    [detail, expanded, threads],
  );
  const renderDetailNode = (node: ThreadAgentGroupNode, depth: number) => (
    <View key={`${node.thread.environmentId}:${node.thread.id}`} style={{ gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open agent ${node.thread.title}. ${threadIdentityLabel(node.thread, driver(node.thread))}`}
        onPress={() => onSelect(node.thread)}
        style={{
          marginLeft: Math.min(depth, MAX_AGENT_GROUP_INDENT) * 16,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          minHeight: 70,
          paddingVertical: 10,
          paddingHorizontal: 12,
          borderLeftWidth: 2,
          borderColor: colors.border,
          borderRadius: 12,
          backgroundColor: colors.surface,
        }}
      >
        <ThreadAvatar thread={node.thread} project={null} providerDriver={driver(node.thread)} />
        <View style={{ flex: 1, gap: 4 }}>
          <AppText
            numberOfLines={2}
            style={{
              color: colors.foreground,
              fontFamily: "DMSans-Medium",
              fontSize: 15,
              lineHeight: 22,
            }}
          >
            {node.thread.title}
          </AppText>
          <AppText numberOfLines={1} style={{ color: colors.muted, fontSize: 13, lineHeight: 19 }}>
            {node.thread.branch ?? node.thread.modelSelection.model}
          </AppText>
        </View>
      </Pressable>
      {node.children.map((child) => renderDetailNode(child, depth + 1))}
    </View>
  );
  if (detail)
    return expanded ? (
      <View style={{ gap: 4 }}>{hierarchy.map((node) => renderDetailNode(node, 0))}</View>
    ) : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={`${threads.length} ${threads.length === 1 ? "agent" : "agents"}. ${expanded ? "Collapse" : "Expand"} agent group`}
      onPress={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      hitSlop={10}
      style={{ flexDirection: "row", alignItems: "center", minHeight: 30 }}
    >
      {threads.slice(0, 4).map((thread, index) => (
        <View
          key={`${thread.environmentId}:${thread.id}`}
          style={{ width: 26, height: 30, marginLeft: index ? -6 : 0 }}
        >
          <ThreadAvatar thread={thread} project={null} providerDriver={driver(thread)} size={26} />
        </View>
      ))}
      {threads.length > 4 ? (
        <View
          style={{
            width: 26,
            height: 26,
            marginLeft: -6,
            alignSelf: "flex-start",
            borderRadius: 13,
            borderWidth: 2,
            borderColor: colors.screen,
            backgroundColor: colors.groupCounter,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <AppText
            style={{
              fontSize: 11,
              lineHeight: 16,
              fontFamily: "DMSans-Medium",
              color: colors.groupCounterForeground,
            }}
          >
            +{threads.length - 4}
          </AppText>
        </View>
      ) : null}
    </Pressable>
  );
}
