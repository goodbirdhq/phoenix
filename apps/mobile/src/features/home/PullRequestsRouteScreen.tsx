import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react-native";
import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type EnvironmentId,
  type PullRequestListCursors,
  type PullRequestListEntry,
  type PullRequestListResult,
} from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, Platform, Pressable, View } from "react-native";
import IconGitPullRequest from "@tabler/icons-react-native/IconGitPullRequest";
import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentServerConfigsAtom } from "../../state/server";
import { useWorkspaceState } from "../../state/workspace";
import { useEnvironmentQuery } from "../../state/query";
import { AppText } from "../../components/AppText";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { useNavigationColors } from "../../components/useNavigationColors";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  applyPullRequestPage,
  EMPTY_PULL_REQUEST_PAGE_STATE,
  hasPullRequestContinuation,
  pullRequestPageInput,
  type PullRequestPageState,
} from "./pull-request-paging";

const list = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "mobile:pull-requests:list",
  tag: WS_METHODS.pullRequestsList,
  staleTimeMs: 30_000,
});

interface PageRequest {
  readonly id: number;
  readonly mode: "replace" | "append";
  readonly cursors: PullRequestListCursors | null;
  readonly forceRefresh: boolean;
}

interface EnvironmentPage {
  readonly page: PullRequestPageState;
  readonly request: PageRequest;
  readonly appliedData: PullRequestListResult | null;
  readonly isPending: boolean;
  readonly queryError: string | null;
}

const INITIAL_REQUEST: PageRequest = {
  id: 0,
  mode: "replace",
  cursors: null,
  forceRefresh: false,
};

const initialEnvironmentPage = (request = INITIAL_REQUEST): EnvironmentPage => ({
  page: EMPTY_PULL_REQUEST_PAGE_STATE,
  request,
  appliedData: null,
  isPending: true,
  queryError: null,
});

type PullRequestRow =
  | {
      readonly type: "environment";
      readonly key: string;
      readonly label: string;
      readonly first: boolean;
    }
  | {
      readonly type: "message";
      readonly key: string;
      readonly text: string;
      readonly alert?: boolean;
    }
  | { readonly type: "loading"; readonly key: string }
  | {
      readonly type: "pull-request";
      readonly key: string;
      readonly environmentId: EnvironmentId;
      readonly pullRequest: PullRequestListEntry;
    }
  | {
      readonly type: "action";
      readonly key: string;
      readonly environmentId: EnvironmentId;
      readonly action: "refresh" | "load-more";
      readonly disabled: boolean;
    };

export function PullRequestsRouteScreen() {
  const navigation = useNavigation();
  const colors = useNavigationColors();
  const { environments } = useWorkspaceState();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const [pages, setPages] = useState<ReadonlyMap<EnvironmentId, EnvironmentPage>>(() => new Map());
  const [openErrors, setOpenErrors] = useState<ReadonlySet<EnvironmentId>>(() => new Set());

  const queryEnvironmentIds = useMemo(
    () =>
      environments
        .filter(
          (environment) =>
            environment.connectionState === "connected" &&
            configs.get(environment.environmentId)?.environment.capabilities.pullRequests === true,
        )
        .map((environment) => environment.environmentId),
    [configs, environments],
  );

  const handleQueryState = useCallback(
    (
      environmentId: EnvironmentId,
      request: PageRequest,
      query: {
        readonly data: PullRequestListResult | null;
        readonly error: string | null;
        readonly isPending: boolean;
      },
    ) => {
      setPages((previous) => {
        const held = previous.get(environmentId) ?? initialEnvironmentPage(request);
        if (held.request.id !== request.id) return previous;
        let page = held.page;
        let appliedData = held.appliedData;
        if (query.data !== null && held.appliedData !== query.data) {
          page = applyPullRequestPage(held.page, query.data, request.mode);
          appliedData = query.data;
        }
        if (
          page === held.page &&
          appliedData === held.appliedData &&
          query.isPending === held.isPending &&
          query.error === held.queryError
        ) {
          return previous;
        }
        const next = new Map(previous);
        next.set(environmentId, {
          ...held,
          page,
          appliedData,
          isPending: query.isPending,
          queryError: query.error,
        });
        return next;
      });
    },
    [],
  );

  const startRequest = useCallback((environmentId: EnvironmentId, mode: "replace" | "append") => {
    setPages((previous) => {
      const held = previous.get(environmentId) ?? initialEnvironmentPage();
      const cursors = mode === "append" ? held.page.nextCursors : null;
      if (mode === "append" && !hasPullRequestContinuation(held.page)) return previous;
      const next = new Map(previous);
      next.set(environmentId, {
        ...held,
        request: {
          id: held.request.id + 1,
          mode,
          cursors,
          // Refresh and a retry of a failed continuation can address the same
          // cached query atom, so explicitly make it perform another request.
          forceRefresh: mode === "replace" || held.queryError !== null,
        },
        appliedData: null,
        isPending: true,
        queryError: null,
      });
      return next;
    });
  }, []);

  const openPullRequest = useCallback((environmentId: EnvironmentId, url: string) => {
    setOpenErrors((previous) => {
      if (!previous.has(environmentId)) return previous;
      const next = new Set(previous);
      next.delete(environmentId);
      return next;
    });
    void Linking.openURL(url).catch(() => {
      setOpenErrors((previous) => new Set(previous).add(environmentId));
    });
  }, []);

  const rows = useMemo(() => {
    const result: PullRequestRow[] = [];
    if (environments.length === 0) {
      result.push({ type: "message", key: "no-environments", text: "No environments connected." });
      return result;
    }
    environments.forEach((environment, index) => {
      const environmentId = environment.environmentId;
      result.push({
        type: "environment",
        key: `environment:${environmentId}`,
        label: environment.environmentLabel,
        first: index === 0,
      });
      if (environment.connectionState !== "connected") {
        result.push({
          type: "message",
          key: `offline:${environmentId}`,
          text: "Connect this environment to load pull requests.",
        });
        return;
      }
      if (configs.get(environmentId)?.environment.capabilities.pullRequests !== true) {
        result.push({
          type: "message",
          key: `unsupported:${environmentId}`,
          text: "Update this environment to browse pull requests.",
        });
        return;
      }

      const environmentPage = pages.get(environmentId);
      const page = environmentPage?.page ?? EMPTY_PULL_REQUEST_PAGE_STATE;
      if (openErrors.has(environmentId)) {
        result.push({
          type: "message",
          key: `open-error:${environmentId}`,
          text: "Could not open this pull request.",
          alert: true,
        });
      }
      if (environmentPage?.queryError) {
        result.push({
          type: "message",
          key: `query-error:${environmentId}`,
          text: environmentPage.queryError,
          alert: true,
        });
      }
      for (const error of page.errors) {
        result.push({
          type: "message",
          key: `project-error:${environmentId}:${error.projectId}`,
          text: `${error.projectTitle}: ${error.message}`,
          alert: true,
        });
      }
      for (const pullRequest of page.entries) {
        result.push({
          type: "pull-request",
          key: `pull-request:${environmentId}:${pullRequest.host}:${pullRequest.repository}:${pullRequest.number}`,
          environmentId,
          pullRequest,
        });
      }
      if (environmentPage?.isPending || environmentPage === undefined) {
        result.push({ type: "loading", key: `loading:${environmentId}` });
      } else if (page.entries.length === 0 && environmentPage.queryError === null) {
        result.push({
          type: "message",
          key: `empty:${environmentId}`,
          text: "No open pull requests.",
        });
      }
      result.push({
        type: "action",
        key: `refresh:${environmentId}`,
        environmentId,
        action: "refresh",
        disabled: environmentPage?.isPending === true,
      });
      if (hasPullRequestContinuation(page)) {
        result.push({
          type: "action",
          key: `load-more:${environmentId}`,
          environmentId,
          action: "load-more",
          disabled: environmentPage?.isPending === true,
        });
      } else if (page.truncated) {
        result.push({
          type: "message",
          key: `continuation-unavailable:${environmentId}`,
          text: "More pull requests are available, but this provider cannot continue the listing.",
        });
      }
    });
    return result;
  }, [configs, environments, openErrors, pages]);

  const renderItem = useCallback(
    ({ item }: LegendListRenderItemProps<PullRequestRow>) => {
      if (item.type === "environment") {
        return (
          <AppText
            className="font-t3-medium"
            style={{ marginTop: item.first ? 0 : 20, marginBottom: 8 }}
          >
            {item.label}
          </AppText>
        );
      }
      if (item.type === "message") {
        return (
          <AppText
            accessibilityRole={item.alert ? "alert" : undefined}
            style={{ color: item.alert ? colors.danger : colors.muted, marginBottom: 8 }}
          >
            {item.text}
          </AppText>
        );
      }
      if (item.type === "loading") {
        return (
          <View style={{ minHeight: 44, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator />
          </View>
        );
      }
      if (item.type === "action") {
        const label = item.action === "refresh" ? "Refresh" : "Load more";
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: item.disabled }}
            disabled={item.disabled}
            onPress={() =>
              startRequest(item.environmentId, item.action === "refresh" ? "replace" : "append")
            }
            style={{ minHeight: 44, justifyContent: "center", opacity: item.disabled ? 0.5 : 1 }}
          >
            <AppText style={{ color: colors.accent }}>{label}</AppText>
          </Pressable>
        );
      }
      const pullRequest = item.pullRequest;
      return (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`${pullRequest.title}, ${pullRequest.repository} #${pullRequest.number}`}
          onPress={() => openPullRequest(item.environmentId, pullRequest.url)}
          style={{ flexDirection: "row", gap: 10, paddingVertical: 10, alignItems: "center" }}
        >
          <IconGitPullRequest size={20} color={colors.accent} />
          <View style={{ flex: 1, gap: 4 }}>
            <AppText style={{ fontSize: 16, color: colors.foreground }}>
              {pullRequest.title}
            </AppText>
            <AppText style={{ fontSize: 13, color: colors.muted }}>
              {pullRequest.repository} · #{pullRequest.number}
              {pullRequest.isDraft ? " · Draft" : ""}
            </AppText>
          </View>
        </Pressable>
      );
    },
    [colors, openPullRequest, startRequest],
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.screen }}>
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Pull Requests" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      {queryEnvironmentIds.map((environmentId) => (
        <EnvironmentPullRequestsLoader
          key={environmentId}
          environmentId={environmentId}
          request={pages.get(environmentId)?.request ?? INITIAL_REQUEST}
          onState={handleQueryState}
        />
      ))}
      <LegendList
        contentInsetAdjustmentBehavior="automatic"
        data={rows}
        estimatedItemSize={64}
        getItemType={(item) => item.type}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        recycleItems
        contentContainerStyle={{ padding: 20 }}
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
      />
    </View>
  );
}

function EnvironmentPullRequestsLoader({
  environmentId,
  request,
  onState,
}: {
  readonly environmentId: EnvironmentId;
  readonly request: PageRequest;
  readonly onState: (
    environmentId: EnvironmentId,
    request: PageRequest,
    query: {
      readonly data: PullRequestListResult | null;
      readonly error: string | null;
      readonly isPending: boolean;
    },
  ) => void;
}) {
  const query = useEnvironmentQuery(
    list({
      environmentId,
      input: pullRequestPageInput(request.cursors),
    }),
  );
  const refreshedRequestId = useRef<number | null>(null);

  useEffect(() => {
    if (!request.forceRefresh || refreshedRequestId.current === request.id) return;
    refreshedRequestId.current = request.id;
    query.refresh();
  }, [query.refresh, request.forceRefresh, request.id]);

  useEffect(() => {
    onState(environmentId, request, query);
  }, [environmentId, onState, query.data, query.error, query.isPending, request]);

  return null;
}
