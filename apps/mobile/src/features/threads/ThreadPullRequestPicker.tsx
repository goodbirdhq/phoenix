import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
} from "@t3tools/shared/threadPullRequests";
import type { RefObject } from "react";
import { Alert, Pressable, View } from "react-native";

import { AppText } from "../../components/AppText";
import { ModalSlideUp } from "../../components/ModalSlideUp";
import { SymbolView } from "../../components/AppSymbol";
import { useNavigationColors } from "../../components/useNavigationColors";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import type { ThreadPrPresentation } from "../../state/use-thread-pr";

/**
 * A row-owned PR chooser. It deliberately receives the row's thread instead
 * of reading selected-thread state, so a nested child can never show its
 * parent's links when opened from a sidebar or tablet pane.
 */
export function ThreadPullRequestPicker(props: {
  readonly thread: Pick<EnvironmentThreadShell, "title" | "pullRequests">;
  readonly presentation: ThreadPrPresentation;
  readonly returnFocusRef?: RefObject<View | null>;
  readonly onClose: () => void;
}) {
  const colors = useNavigationColors();
  const chains = resolveThreadPullRequestChains(props.thread.pullRequests);
  const links = chains.flatMap((chain) => chain.layers);
  const open = (url: string) => {
    void tryOpenExternalUrl(url, "pull-request").then((opened) => {
      if (!opened) Alert.alert("Unable to open PR", "The pull request could not be opened.");
    });
  };

  return (
    <ModalSlideUp
      title="Linked pull requests"
      description={props.thread.title}
      identity={<SymbolView name="arrow.triangle.pull" size={34} tintColor={colors.accent} />}
      identityLabel={props.presentation.accessibilityLabel}
      returnFocusRef={props.returnFocusRef}
      onClose={props.onClose}
    >
      {links.length > 0 ? (
        chains.map((chain) => (
          <View
            key={threadPullRequestKeyOf(chain.layers[0]!)}
            style={{ overflow: "hidden", borderRadius: 14, backgroundColor: colors.secondary }}
          >
            {chain.layers.map((link, index) => (
              <Pressable
                key={threadPullRequestKeyOf(link)}
                accessibilityRole="button"
                accessibilityLabel={`Open #${link.number} ${link.snapshot?.title ?? "pull request"}`}
                onPress={() => open(link.url)}
                style={({ pressed }) => ({
                  minHeight: 58,
                  justifyContent: "center",
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  opacity: pressed ? 0.65 : 1,
                  borderTopWidth: index === 0 ? 0 : 1,
                  borderColor: colors.border,
                })}
              >
                <AppText
                  style={{ color: colors.foreground, fontSize: 15, fontFamily: "DMSans-Medium" }}
                >
                  #{link.number} {link.snapshot?.title ?? "Pull request"}
                </AppText>
                <AppText style={{ color: colors.muted, fontSize: 13 }}>
                  {link.repository} ·{" "}
                  {link.snapshot === null
                    ? "Status pending"
                    : link.snapshot.isDraft && link.snapshot.state === "open"
                      ? "Draft"
                      : link.snapshot.state}
                </AppText>
              </Pressable>
            ))}
          </View>
        ))
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${props.presentation.accessibilityLabel}`}
          onPress={() => open(props.presentation.url)}
          style={({ pressed }) => ({
            minHeight: 58,
            justifyContent: "center",
            borderRadius: 14,
            backgroundColor: colors.secondary,
            paddingHorizontal: 14,
            paddingVertical: 10,
            opacity: pressed ? 0.65 : 1,
          })}
        >
          <AppText style={{ color: colors.foreground, fontSize: 15, fontFamily: "DMSans-Medium" }}>
            #{props.presentation.label}
          </AppText>
          <AppText style={{ color: colors.muted, fontSize: 13 }}>Open pull request</AppText>
        </Pressable>
      )}
    </ModalSlideUp>
  );
}
