import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Pressable, View } from "react-native";
import { ThreadAvatar } from "../../components/ThreadAvatar";
import { AppText } from "../../components/AppText";
import { useNavigationColors } from "../../components/useNavigationColors";
import { useServerConfigs } from "../../state/entities";

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
  if (detail)
    return expanded ? (
      <View style={{ gap: 4 }}>
        {threads.map((thread) => (
          <Pressable
            key={`${thread.environmentId}:${thread.id}`}
            accessibilityRole="button"
            accessibilityLabel={`Open agent ${thread.title}`}
            onPress={() => onSelect(thread)}
            style={{
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
            <ThreadAvatar thread={thread} project={null} providerDriver={driver(thread)} />
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
                {thread.title}
              </AppText>
              <AppText
                numberOfLines={1}
                style={{ color: colors.muted, fontSize: 13, lineHeight: 19 }}
              >
                {thread.branch ?? thread.modelSelection.model}
              </AppText>
            </View>
          </Pressable>
        ))}
      </View>
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
      style={{ flexDirection: "row", alignItems: "center", minHeight: 25 }}
    >
      {threads.slice(0, 4).map((thread, index) => (
        <View key={`${thread.environmentId}:${thread.id}`} style={{ marginLeft: index ? -7 : 0 }}>
          <ThreadAvatar thread={thread} project={null} providerDriver={driver(thread)} size={20} />
        </View>
      ))}
      {threads.length > 4 ? (
        <AppText style={{ fontSize: 11, color: colors.muted, paddingLeft: 4 }}>
          +{threads.length - 4}
        </AppText>
      ) : null}
    </Pressable>
  );
}
