import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import {
  CommandId,
  EnvironmentId,
  OccurrenceId,
  ScheduleId,
  type ScheduleHistoryEntry,
  type ScheduleHistoryCursor,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { StatusPill } from "../../components/StatusPill";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { uuidv4 } from "../../lib/uuid";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  MAX_VISIBLE_SCHEDULE_HISTORY,
  mergeOlderScheduleHistory,
  scheduleHistoryEntryKey,
} from "./schedule-screen-model";
import {
  useMobileScheduleDetail,
  useMobileScheduleHistoryPage,
  useMobileScheduleOverview,
  useScheduleDispatch,
} from "./use-mobile-schedules";

type Props = StaticScreenProps<{
  readonly environmentId: string;
  readonly scheduleId: string;
}>;

const STATE_TONE = {
  enabled: { label: "Enabled", pillClassName: "bg-success/15", textClassName: "text-success" },
  paused: { label: "Paused", pillClassName: "bg-subtle", textClassName: "text-foreground-muted" },
  completed: { label: "Completed", pillClassName: "bg-primary/12", textClassName: "text-primary" },
  failed: {
    label: "Failed",
    pillClassName: "bg-danger/15",
    textClassName: "text-danger-foreground",
  },
} as const;

function commandId() {
  return CommandId.make(uuidv4());
}

export function ScheduleDetailRouteScreen(props: Props) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const scheduleId = ScheduleId.make(props.route.params.scheduleId);
  const { environments } = useMobileScheduleOverview();
  const environment =
    environments.find((candidate) => candidate.environmentId === environmentId) ?? null;
  const online = environment?.online === true && environment.supportsSchedules;
  const scheduleRevision =
    environment?.schedules.find((schedule) => schedule.id === scheduleId)?.revision ?? null;
  const { detail, error, isLoading, refresh, source } = useMobileScheduleDetail(
    environmentId,
    scheduleId,
    online,
    scheduleRevision,
  );
  const dispatch = useScheduleDispatch();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const acknowledgedRef = useRef(false);
  const detailVersion =
    detail === null ? null : `${scheduleRevision ?? 0}:${detail.id}:${detail.updatedAt}`;
  const [historyState, setHistoryState] = useState<{
    readonly detailVersion: string | null;
    readonly older: readonly ScheduleHistoryEntry[];
    readonly nextCursor: ScheduleHistoryCursor | null;
    readonly requestedCursor: ScheduleHistoryCursor | null;
  }>({ detailVersion: null, older: [], nextCursor: null, requestedCursor: null });
  const currentHistoryState =
    historyState.detailVersion === detailVersion
      ? historyState
      : {
          detailVersion,
          older: [],
          nextCursor: detail?.historyNextCursor ?? null,
          requestedCursor: null,
        };
  const recentHistory = detail?.history ?? [];
  const visibleHistory = [...currentHistoryState.older, ...recentHistory];
  const displayedHistory = visibleHistory.toReversed();
  const remainingHistoryCapacity = Math.max(
    0,
    MAX_VISIBLE_SCHEDULE_HISTORY - visibleHistory.length,
  );
  const historyPage = useMobileScheduleHistoryPage({
    environmentId,
    scheduleId,
    cursor: currentHistoryState.requestedCursor,
    limit: Math.max(1, Math.min(50, remainingHistoryCapacity)),
    enabled: online && remainingHistoryCapacity > 0,
  });

  useEffect(() => {
    const requestedCursor = currentHistoryState.requestedCursor;
    const page = historyPage.data;
    if (detail === null || requestedCursor === null || page === null) return;
    if (page.scheduleId !== scheduleId) return;
    setHistoryState((current) => {
      const base = current.detailVersion === detailVersion ? current : currentHistoryState;
      if (base.requestedCursor !== requestedCursor) return current;
      return {
        detailVersion,
        older: mergeOlderScheduleHistory({
          currentOlder: base.older,
          page: page.entries,
          recent: detail.history,
          maximum: MAX_VISIBLE_SCHEDULE_HISTORY,
        }),
        nextCursor: page.nextCursor,
        requestedCursor: null,
      };
    });
  }, [currentHistoryState, detail, detailVersion, historyPage.data, scheduleId]);

  const run = async (label: string, command: Parameters<typeof dispatch>[1]) => {
    if (!online || busyAction !== null) return false;
    setBusyAction(label);
    const result = await dispatch(environmentId, command);
    setBusyAction(null);
    if (!result.ok) Alert.alert(`${label} failed`, result.error);
    else refresh();
    return result.ok;
  };

  useEffect(() => {
    if (!detail?.unacknowledgedFailure) {
      acknowledgedRef.current = false;
      return;
    }
    if (!online || acknowledgedRef.current) return;
    acknowledgedRef.current = true;
    void dispatch(environmentId, {
      type: "schedule.acknowledge-failures",
      commandId: commandId(),
      scheduleId,
    }).then((result) => {
      if (result.ok) return;
      acknowledgedRef.current = false;
      Alert.alert("Could not acknowledge failure", result.error);
    });
  }, [detail?.unacknowledgedFailure, dispatch, environmentId, online, scheduleId]);

  const confirmDelete = () => {
    if (!detail || !online) return;
    Alert.alert(
      `Delete ${detail.name}?`,
      "This deletes the Schedule and its history. Threads it already created will remain.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete Schedule",
          style: "destructive",
          onPress: () => {
            void run("Delete Schedule", {
              type: "schedule.delete",
              commandId: commandId(),
              scheduleId,
            }).then((ok) => {
              if (ok) navigation.goBack();
            });
          },
        },
      ],
    );
  };

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={detail?.name ?? "Schedule"}
            onBack={() => navigation.goBack()}
          />
        </>
      ) : (
        <NativeStackScreenOptions options={{ title: detail?.name ?? "Schedule" }} />
      )}
      {isLoading ? (
        <View className="flex-1 items-center justify-center gap-3">
          <ActivityIndicator />
          <Text className="text-sm text-foreground-muted">Opening Schedule…</Text>
        </View>
      ) : detail === null ? (
        <View className="flex-1 items-center justify-center px-5">
          <EmptyState
            title="Schedule unavailable"
            detail={error ?? "This Schedule is not cached on this device."}
          />
        </View>
      ) : (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {source === "cache" || !online ? (
            <View className="rounded-2xl bg-subtle px-4 py-3">
              <Text className="text-sm text-foreground-muted">
                {environment?.online === false
                  ? `${environment.label} is offline. Cached Schedule data is read-only.`
                  : "This Environment must be updated before it can manage Schedules."}
              </Text>
            </View>
          ) : null}

          <SettingsSection title="Schedule" card>
            <View className="gap-3 p-4">
              <View className="flex-row items-center justify-between gap-3">
                <Text className="min-w-0 flex-1 text-xl font-t3-bold text-foreground">
                  {detail.name}
                </Text>
                <StatusPill {...STATE_TONE[detail.state]} size="compact" />
              </View>
              <Text selectable className="text-base leading-normal text-foreground">
                {detail.prompt}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {detail.timing.type === "one-time"
                  ? `Once · ${formatDate(detail.timing.runAt, detail.timeZone)} · ${detail.timeZone}`
                  : `${detail.timing.expression} · ${detail.timeZone}`}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {environment?.projects.find((project) => project.id === detail.projectId)?.title ??
                  "Unknown project"}
                {environment ? ` · ${environment.label}` : ""}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {detail.execution.modelSelection.instanceId}/{detail.execution.modelSelection.model}{" "}
                · {detail.execution.runtimeMode} ·{" "}
                {detail.execution.workspaceMode === "local" ? "Shared workspace" : "New worktree"}
              </Text>
            </View>
          </SettingsSection>

          <SettingsSection title="Actions" card>
            <ActionRow
              disabled={!online || busyAction !== null}
              label="Run now"
              detail="Creates a fresh Thread without changing the cadence."
              onPress={() =>
                void run("Run now", {
                  type: "schedule.run-now",
                  commandId: commandId(),
                  scheduleId,
                  occurrenceId: OccurrenceId.make(uuidv4()),
                })
              }
            />
            {detail.state === "paused" ? (
              <ActionRow
                disabled={!online || busyAction !== null}
                label="Resume"
                detail="Starts with the next future Occurrence; paused time is not caught up."
                onPress={() =>
                  void run("Resume", {
                    type: "schedule.resume",
                    commandId: commandId(),
                    scheduleId,
                  })
                }
              />
            ) : detail.state === "enabled" ? (
              <ActionRow
                disabled={!online || busyAction !== null}
                label="Pause"
                detail="Produces no Occurrences until resumed."
                onPress={() =>
                  void run("Pause", { type: "schedule.pause", commandId: commandId(), scheduleId })
                }
              />
            ) : null}
            <ActionRow
              disabled={!online || busyAction !== null}
              label="Edit"
              onPress={() =>
                navigation.navigate("SettingsSheet", {
                  screen: "SettingsContent",
                  params: { screen: "SettingsScheduleEdit", params: { environmentId, scheduleId } },
                })
              }
            />
            <ActionRow
              disabled={!online || busyAction !== null}
              label="Duplicate"
              detail="Creates a new Schedule; choose any online Environment and Project."
              onPress={() =>
                navigation.navigate("SettingsSheet", {
                  screen: "SettingsContent",
                  params: {
                    screen: "SettingsScheduleDuplicate",
                    params: { environmentId, scheduleId },
                  },
                })
              }
            />
            <ActionRow
              destructive
              disabled={!online || busyAction !== null}
              label="Delete Schedule"
              onPress={confirmDelete}
            />
          </SettingsSection>

          <SettingsSection title="History" card>
            {currentHistoryState.nextCursor !== null ||
            currentHistoryState.requestedCursor !== null ? (
              <View className="gap-2 border-b border-separator p-4">
                {remainingHistoryCapacity === 0 ? (
                  <Text className="text-sm text-foreground-muted">
                    Showing the newest {MAX_VISIBLE_SCHEDULE_HISTORY} entries.
                  </Text>
                ) : !online ? (
                  <Text className="text-sm text-foreground-muted">
                    Older history is available when this Environment reconnects.
                  </Text>
                ) : historyPage.error ? (
                  <>
                    <Text className="text-sm text-danger-foreground">{historyPage.error}</Text>
                    <Pressable accessibilityRole="button" onPress={historyPage.refresh}>
                      <Text className="text-sm font-t3-bold text-primary">Retry older history</Text>
                    </Pressable>
                  </>
                ) : currentHistoryState.requestedCursor !== null ? (
                  <View className="flex-row items-center gap-2">
                    <ActivityIndicator size="small" />
                    <Text className="text-sm text-foreground-muted">Loading older history…</Text>
                  </View>
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() =>
                      setHistoryState({
                        ...currentHistoryState,
                        requestedCursor: currentHistoryState.nextCursor,
                      })
                    }
                  >
                    <Text className="text-sm font-t3-bold text-primary">Load older history</Text>
                  </Pressable>
                )}
              </View>
            ) : null}
            {visibleHistory.length === 0 ? (
              <Text className="p-4 text-sm text-foreground-muted">No Occurrences yet.</Text>
            ) : (
              displayedHistory.map((entry) => (
                <HistoryRow
                  key={scheduleHistoryEntryKey(entry)}
                  entry={entry}
                  timeZone={detail.timeZone}
                  onOpenThread={(threadId) =>
                    navigation.navigate("Thread", { environmentId, threadId })
                  }
                />
              ))
            )}
          </SettingsSection>
        </ScrollView>
      )}
    </View>
  );
}

function ActionRow(props: {
  readonly label: string;
  readonly detail?: string;
  readonly disabled: boolean;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      className="gap-1 border-b border-separator px-4 py-3.5 last:border-b-0 disabled:opacity-40"
      onPress={props.onPress}
    >
      <Text
        className={
          props.destructive
            ? "text-base font-t3-bold text-danger-foreground"
            : "text-base font-t3-bold text-foreground"
        }
      >
        {props.label}
      </Text>
      {props.detail ? <Text className="text-sm text-foreground-muted">{props.detail}</Text> : null}
    </Pressable>
  );
}

function HistoryRow(props: {
  readonly entry: ScheduleHistoryEntry;
  readonly timeZone: string;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const entry = props.entry;
  if (entry.type === "triggered") {
    return (
      <Pressable
        className="gap-1 border-b border-separator px-4 py-3.5 last:border-b-0"
        onPress={() => props.onOpenThread(entry.threadId)}
      >
        <Text className="text-base font-t3-bold text-foreground">Triggered</Text>
        <Text className="text-sm text-foreground-muted">
          Scheduled {formatDate(entry.scheduledFor, props.timeZone)} · Triggered{" "}
          {formatDate(entry.triggeredAt, props.timeZone)} · Open Thread
        </Text>
      </Pressable>
    );
  }
  if (entry.type === "failed") {
    return (
      <View className="gap-1 border-b border-separator px-4 py-3.5 last:border-b-0">
        <Text className="text-base font-t3-bold text-danger-foreground">
          Failed{entry.count > 1 ? ` ×${entry.count}` : ""}
        </Text>
        <Text selectable className="text-sm text-foreground-muted">
          {entry.code} · {entry.message}
        </Text>
        <Text className="text-xs text-foreground-tertiary">
          {entry.count > 1 ? (
            <>
              {formatDate(entry.firstFailedAt, props.timeZone)} –{" "}
              {formatDate(entry.lastFailedAt, props.timeZone)}
            </>
          ) : (
            formatDate(entry.lastFailedAt, props.timeZone)
          )}
        </Text>
      </View>
    );
  }
  return (
    <View className="gap-1 border-b border-separator px-4 py-3.5 last:border-b-0">
      <Text className="text-base font-t3-bold text-foreground">
        Skipped {entry.countIsLowerBound ? "at least " : "×"}
        {entry.count}
      </Text>
      <Text className="text-sm text-foreground-muted">
        {formatDate(entry.firstScheduledFor, props.timeZone)} –{" "}
        {formatDate(entry.lastScheduledFor, props.timeZone)}
      </Text>
    </View>
  );
}

function formatDate(value: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(value));
}
