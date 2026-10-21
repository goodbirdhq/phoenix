import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { Pressable, View } from "react-native";

import { ThreadAvatar } from "../../components/ThreadAvatar";
import { AppText } from "../../components/ui/AppText";
import { useNavigationColors } from "../../components/useNavigationColors";
import { useProject } from "../../state/entities";
import type { ThreadListProvider } from "../../state/thread-list-environments";
import { resolveThreadProviderInstance } from "./thread-provider-instance";

const VISIBLE_AVATARS = 4;

/**
 * The child sessions grouped under a row, as an overlapping avatar stack with
 * each child's own status ring. Tapping expands the nested rows; when every
 * child is pinned (so already a row of its own) the stack only reports them.
 */
export function ThreadAgentGroup({
  threads,
  providers,
  expanded,
  canExpand,
  onToggle,
  parentProjectId,
}: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly providers: ReadonlyArray<ThreadListProvider> | undefined;
  readonly expanded: boolean;
  readonly canExpand: boolean;
  readonly onToggle: () => void;
  readonly parentProjectId: EnvironmentThreadShell["projectId"];
}) {
  const colors = useNavigationColors();
  const count = `${threads.length} ${threads.length === 1 ? "child session" : "child sessions"}`;
  return (
    <Pressable
      accessibilityRole={canExpand ? "button" : undefined}
      accessibilityState={canExpand ? { expanded } : undefined}
      accessibilityLabel={
        canExpand ? `${count}. ${expanded ? "Collapse" : "Expand"}` : `${count}, pinned`
      }
      disabled={!canExpand}
      onPress={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      // Without a long-press handler a hold that opens the row's iOS context
      // menu would also toggle the group on release.
      onLongPress={() => undefined}
      hitSlop={10}
      style={{ flexDirection: "row", alignItems: "center", minHeight: 26 }}
    >
      {threads.slice(0, VISIBLE_AVATARS).map((thread, index) => (
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
          <ChildAvatar thread={thread} providers={providers} parentProjectId={parentProjectId} />
        </View>
      ))}
      {threads.length > VISIBLE_AVATARS ? (
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
            className="font-t3-medium"
            style={{ fontSize: 11, lineHeight: 16, color: colors.groupCounterForeground }}
          >
            +{threads.length - VISIBLE_AVATARS}
          </AppText>
        </View>
      ) : null}
    </Pressable>
  );
}

function ChildAvatar(props: {
  readonly thread: EnvironmentThreadShell;
  readonly providers: ReadonlyArray<ThreadListProvider> | undefined;
  readonly parentProjectId: EnvironmentThreadShell["projectId"];
}) {
  const sameProject = props.thread.projectId === props.parentProjectId;
  const project = useProject(
    sameProject
      ? null
      : { environmentId: props.thread.environmentId, projectId: props.thread.projectId },
  );
  return (
    <ThreadAvatar
      thread={props.thread}
      project={project}
      providerDriver={
        resolveThreadProviderInstance(props.providers, props.thread)?.driverKind ?? null
      }
      size={24}
    />
  );
}
