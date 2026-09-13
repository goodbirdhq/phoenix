import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Pressable, View } from "react-native";
import { ThreadAvatar } from "../../components/ThreadAvatar";
import { AppText } from "../../components/AppText";
import { useNavigationColors } from "../../components/useNavigationColors";
import { useProjects, useServerConfigs } from "../../state/entities";
import { resolveThreadAgentGroupPress } from "./thread-agent-group-disclosure";

export function ThreadAgentGroup({
  threads,
  expanded,
  canExpand,
  onToggle,
  onDetails,
  parentProjectId,
}: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
  expanded: boolean;
  canExpand: boolean;
  onToggle: () => void;
  onDetails: () => void;
  parentProjectId: EnvironmentThreadShell["projectId"];
}) {
  const configs = useServerConfigs();
  const projects = useProjects();
  const colors = useNavigationColors();
  const driver = (thread: EnvironmentThreadShell) =>
    configs
      .get(thread.environmentId)
      ?.providers.find(
        (p) =>
          p.instanceId === (thread.session?.providerInstanceId ?? thread.modelSelection.instanceId),
      )?.driver ?? null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={canExpand ? { expanded } : {}}
      accessibilityLabel={`${threads.length} ${threads.length === 1 ? "agent" : "agents"}. ${canExpand ? `${expanded ? "Collapse" : "Expand"} agent group` : "Session details"}`}
      onPress={(event) => {
        event.stopPropagation();
        if (resolveThreadAgentGroupPress(canExpand) === "toggle") onToggle();
        else onDetails();
      }}
      onLongPress={(event) => {
        event.stopPropagation();
        onDetails();
      }}
      accessibilityHint={
        canExpand
          ? "Tap to expand or collapse. Long press for session details."
          : "Tap for session details. These sessions are pinned separately."
      }
      hitSlop={10}
      style={{ flexDirection: "row", alignItems: "center", minHeight: 26 }}
    >
      {threads.slice(0, 4).map((thread, index) => (
        <View
          key={`${thread.environmentId}:${thread.id}`}
          style={{
            width: 26,
            height: 26,
            alignItems: "center",
            justifyContent: "center",
            marginLeft: index ? -6 : 0,
          }}
        >
          <ThreadAvatar
            thread={thread}
            project={
              thread.projectId === parentProjectId
                ? null
                : (projects.find(
                    (p) => p.environmentId === thread.environmentId && p.id === thread.projectId,
                  ) ?? null)
            }
            providerDriver={driver(thread)}
            size={24}
          />
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
