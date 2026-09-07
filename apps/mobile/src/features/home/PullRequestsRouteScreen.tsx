import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, View } from "react-native";
import IconGitPullRequest from "@tabler/icons-react-native/IconGitPullRequest";
import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentServerConfigsAtom } from "../../state/server";
import { useWorkspaceState } from "../../state/workspace";
import { useEnvironmentQuery } from "../../state/query";
import { AppText } from "../../components/AppText";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { useNavigationColors } from "../../components/useNavigationColors";

const list = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:pull-requests:list",
  tag: WS_METHODS.pullRequestsList,
  staleTimeMs: 30_000,
});
export function PullRequestsRouteScreen() {
  const navigation = useNavigation();
  const colors = useNavigationColors();
  const { environments } = useWorkspaceState();
  const configs = useAtomValue(environmentServerConfigsAtom);
  return (
    <View style={{ flex: 1, backgroundColor: colors.screen }}>
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Pull Requests" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView contentContainerStyle={{ padding: 20, gap: 20 }}>
        {environments.length === 0 ? <AppText>No environments connected.</AppText> : null}
        {environments.map((environment) => (
          <View key={environment.environmentId} style={{ gap: 8 }}>
            <AppText className="font-t3-medium">{environment.environmentLabel}</AppText>
            {environment.connectionState !== "connected" ? (
              <AppText style={{ color: colors.muted }}>
                Connect this environment to load pull requests.
              </AppText>
            ) : configs.get(environment.environmentId)?.environment.capabilities.pullRequests !==
              true ? (
              <AppText style={{ color: colors.muted }}>
                Update this environment to browse pull requests.
              </AppText>
            ) : (
              <EnvironmentPullRequests environmentId={environment.environmentId} />
            )}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
function EnvironmentPullRequests({ environmentId }: { environmentId: EnvironmentId }) {
  const [limit, setLimit] = useState(30);
  const colors = useNavigationColors();
  const query = useEnvironmentQuery(list({ environmentId, input: { state: "open", limit } }));
  const [openError, setOpenError] = useState(false);
  return (
    <View style={{ gap: 12 }}>
      {query.isPending ? <ActivityIndicator /> : null}
      {query.error ? (
        <AppText accessibilityRole="alert" style={{ color: colors.danger }}>
          {query.error}
        </AppText>
      ) : null}
      {openError ? (
        <AppText accessibilityRole="alert" style={{ color: colors.danger }}>
          Could not open this pull request.
        </AppText>
      ) : null}
      {query.data?.errors.map((error) => (
        <AppText key={error.projectId} style={{ color: colors.danger }}>
          {error.projectTitle}: {error.message}
        </AppText>
      ))}
      {query.data?.entries.length === 0 ? (
        <AppText style={{ color: colors.muted }}>No open pull requests.</AppText>
      ) : null}
      {query.data?.entries.map((pr) => (
        <Pressable
          key={`${pr.host}:${pr.repository}:${pr.number}`}
          accessibilityRole="link"
          accessibilityLabel={`${pr.title}, ${pr.repository} #${pr.number}`}
          onPress={() => {
            setOpenError(false);
            void Linking.openURL(pr.url).catch(() => setOpenError(true));
          }}
          style={{ flexDirection: "row", gap: 10, paddingVertical: 10, alignItems: "center" }}
        >
          <IconGitPullRequest size={20} color={colors.accent} />
          <View style={{ flex: 1, gap: 4 }}>
            <AppText style={{ fontSize: 16, color: colors.foreground }}>{pr.title}</AppText>
            <AppText style={{ fontSize: 13, color: colors.muted }}>
              {pr.repository} · #{pr.number}
              {pr.isDraft ? " · Draft" : ""}
            </AppText>
          </View>
        </Pressable>
      ))}
      <Pressable
        accessibilityRole="button"
        onPress={query.refresh}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <AppText style={{ color: colors.accent }}>Refresh</AppText>
      </Pressable>
      {query.data?.truncated && limit < 500 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setLimit(Math.min(limit + 30, 500))}
          style={{ minHeight: 44, justifyContent: "center" }}
        >
          <AppText style={{ color: colors.accent }}>Load more</AppText>
        </Pressable>
      ) : null}
    </View>
  );
}
