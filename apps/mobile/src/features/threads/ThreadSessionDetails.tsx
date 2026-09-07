import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { RefObject } from "react";
import { Pressable, View } from "react-native";
import { AppText } from "../../components/AppText";
import { ModalSlideUp } from "../../components/ModalSlideUp";
import { ThreadAvatar, threadIdentityLabel } from "../../components/ThreadAvatar";
import { useNavigationColors } from "../../components/useNavigationColors";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";

export function ThreadSessionDetails(props: {
  thread: EnvironmentThreadShell;
  descendants: ReadonlyArray<EnvironmentThreadShell>;
  project: EnvironmentProject | null;
  providerDriver: string | null;
  returnFocusRef: RefObject<View | null>;
  onClose: () => void;
  onSelect: (thread: EnvironmentThreadShell) => void;
}) {
  const colors = useNavigationColors();
  const configs = useServerConfigs();
  const projects = useProjects();
  const { savedConnectionsById } = useSavedRemoteConnections();
  return (
    <ModalSlideUp
      title="Session details"
      description={`${props.descendants.length + 1} ${props.descendants.length ? "sessions" : "session"} · ${props.thread.title}`}
      identity={
        <ThreadAvatar
          thread={props.thread}
          project={props.project}
          providerDriver={props.providerDriver}
          size={64}
        />
      }
      identityLabel={threadIdentityLabel(props.thread, props.providerDriver)}
      returnFocusRef={props.returnFocusRef}
      onClose={props.onClose}
    >
      {[props.thread, ...props.descendants].map((thread) => {
        const provider = configs
          .get(thread.environmentId)
          ?.providers.find(
            (p) =>
              p.instanceId ===
              (thread.session?.providerInstanceId ?? thread.modelSelection.instanceId),
          );
        const project =
          projects.find(
            (p) => p.environmentId === thread.environmentId && p.id === thread.projectId,
          ) ?? null;
        const providerLabel =
          provider?.displayName ??
          provider?.driver ??
          thread.session?.providerName ??
          "Provider unavailable";
        const environmentLabel =
          savedConnectionsById[thread.environmentId]?.environmentLabel ??
          configs.get(thread.environmentId)?.environment.label;
        return (
          <Pressable
            key={`${thread.environmentId}:${thread.id}`}
            accessibilityRole="button"
            accessibilityLabel={`Open ${thread.title}. ${providerLabel}, ${thread.modelSelection.model}, ${environmentLabel ?? ""}. ${threadIdentityLabel(thread, provider?.driver ?? null)}`}
            onPress={() => {
              props.onClose();
              props.onSelect(thread);
            }}
            style={{
              minHeight: 74,
              flexDirection: "row",
              alignItems: "center",
              paddingVertical: 10,
              gap: 10,
            }}
          >
            <ThreadAvatar
              thread={thread}
              project={
                thread.id === props.thread.id || thread.projectId !== props.thread.projectId
                  ? project
                  : null
              }
              providerDriver={provider?.driver ?? null}
            />
            <View style={{ flex: 1, gap: 4 }}>
              <AppText
                style={{
                  color: colors.foreground,
                  fontSize: 15,
                  lineHeight: 22,
                  fontFamily: "DMSans-Medium",
                }}
              >
                {thread.title}
              </AppText>
              <AppText style={{ color: colors.muted, fontSize: 13, lineHeight: 19 }}>
                {providerLabel} · {thread.modelSelection.model}
              </AppText>
              {environmentLabel ? (
                <AppText style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>
                  {environmentLabel}
                </AppText>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </ModalSlideUp>
  );
}
