import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ScheduleState } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  View,
} from "react-native";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { StatusPill, type StatusTone } from "../../components/StatusPill";
import { SymbolView } from "../../components/AppSymbol";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  buildScheduleRows,
  type MobileSchedule,
  type ScheduleFilters,
  type ScheduleRow,
} from "./schedule-screen-model";
import { useMobileScheduleOverview } from "./use-mobile-schedules";

const STATE_ORDER: readonly (ScheduleState | null)[] = [
  null,
  "enabled",
  "paused",
  "completed",
  "failed",
];

const STATE_TONES: Record<ScheduleState, StatusTone> = {
  enabled: { label: "Enabled", pillClassName: "bg-success/15", textClassName: "text-success" },
  paused: { label: "Paused", pillClassName: "bg-subtle", textClassName: "text-foreground-muted" },
  completed: { label: "Completed", pillClassName: "bg-primary/12", textClassName: "text-primary" },
  failed: {
    label: "Failed",
    pillClassName: "bg-danger/15",
    textClassName: "text-danger-foreground",
  },
};

function cycle<T>(items: readonly T[], current: T): T {
  const index = items.indexOf(current);
  return items[(index + 1) % items.length]!;
}

export function SchedulesRouteScreen() {
  const navigation = useNavigation();
  const { environments, isLoading, refresh } = useMobileScheduleOverview();
  const [filters, setFilters] = useState<ScheduleFilters>({
    environmentId: null,
    projectId: null,
    state: null,
    failuresOnly: false,
  });
  const environmentFilterIds = useMemo(
    () => [null, ...environments.map((environment) => String(environment.environmentId))],
    [environments],
  );
  const projectOptions = useMemo(
    () =>
      environments
        .filter(
          (environment) =>
            filters.environmentId === null ||
            String(environment.environmentId) === filters.environmentId,
        )
        .flatMap((environment) =>
          environment.projects.map((project) => ({
            projectId: String(project.id),
            title: project.title,
          })),
        ),
    [environments, filters.environmentId],
  );
  const projectFilterIds = useMemo(
    () => [null, ...new Set(projectOptions.map((project) => project.projectId))],
    [projectOptions],
  );
  const rows = useMemo(
    () =>
      buildScheduleRows({
        environments: environments.map((environment) => ({
          environmentId: String(environment.environmentId),
          label: environment.label,
          online: environment.online && environment.supportsSchedules,
          projects: environment.projects.map((project) => ({
            projectId: String(project.id),
            title: project.title,
            isGit: null,
          })),
        })),
        schedules: environments.flatMap((environment) =>
          environment.schedules.map(
            (schedule): MobileSchedule => ({
              ...schedule,
              environmentId: String(environment.environmentId),
            }),
          ),
        ),
        filters,
      }),
    [environments, filters],
  );
  const environmentFilterLabel =
    filters.environmentId === null
      ? "All environments"
      : (environments.find(
          (environment) => String(environment.environmentId) === filters.environmentId,
        )?.label ?? "Environment");
  const projectFilterLabel =
    filters.projectId === null
      ? "All projects"
      : (projectOptions.find((project) => project.projectId === filters.projectId)?.title ??
        "Project");

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title="Schedules"
            onBack={() => navigation.goBack()}
            actions={[
              {
                accessibilityLabel: "Create Schedule",
                icon: "plus",
                onPress: () =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: "SettingsScheduleNew", params: {} },
                  }),
              },
            ]}
          />
        </>
      ) : (
        <NativeStackScreenOptions
          options={{
            headerRight: ScheduleCreateHeaderButton,
          }}
        />
      )}

      <View className="gap-2 border-b border-separator px-5 py-3">
        <View className="flex-row gap-2">
          <FilterButton
            label={environmentFilterLabel}
            onPress={() =>
              setFilters((current) => ({
                ...current,
                environmentId: cycle(environmentFilterIds, current.environmentId),
                projectId: null,
              }))
            }
          />
          <FilterButton
            label={projectFilterLabel}
            onPress={() =>
              setFilters((current) => ({
                ...current,
                projectId: cycle(projectFilterIds, current.projectId),
              }))
            }
          />
        </View>
        <View className="flex-row gap-2">
          <FilterButton
            label={filters.state === null ? "All states" : STATE_TONES[filters.state].label}
            onPress={() =>
              setFilters((current) => ({
                ...current,
                state: cycle(STATE_ORDER, current.state),
              }))
            }
          />
          <FilterButton
            active={filters.failuresOnly}
            label="Failures"
            onPress={() =>
              setFilters((current) => ({ ...current, failuresOnly: !current.failuresOnly }))
            }
          />
        </View>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(row) => `${row.environmentId}:${row.scheduleId}`}
        contentContainerClassName="gap-3 px-5 py-4"
        contentContainerStyle={rows.length === 0 ? { flexGrow: 1 } : undefined}
        refreshControl={
          <RefreshControl
            refreshing={environments.some((environment) => environment.synchronizing)}
            onRefresh={refresh}
          />
        }
        renderItem={({ item }) => (
          <ScheduleListRow
            row={item}
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: {
                  screen: "SettingsScheduleDetail",
                  params: {
                    environmentId: item.environmentId as EnvironmentId,
                    scheduleId: item.scheduleId,
                  },
                },
              })
            }
          />
        )}
        ListEmptyComponent={
          isLoading ? (
            <View className="flex-1 items-center justify-center gap-3">
              <ActivityIndicator />
              <Text className="text-sm text-foreground-muted">Loading Schedules…</Text>
            </View>
          ) : (
            <View className="flex-1 items-center justify-center">
              <EmptyState
                title={environments.length === 0 ? "No environments" : "No Schedules"}
                detail={
                  environments.length === 0
                    ? "Connect an environment before creating a Schedule."
                    : "Create a Schedule or change the filters above."
                }
              />
            </View>
          )
        }
      />
    </View>
  );
}

function ScheduleCreateHeaderButton() {
  const navigation = useNavigation();
  return (
    <Pressable
      accessibilityLabel="Create Schedule"
      accessibilityRole="button"
      hitSlop={8}
      onPress={() =>
        navigation.navigate("SettingsSheet", {
          screen: "SettingsContent",
          params: { screen: "SettingsScheduleNew", params: {} },
        })
      }
    >
      <SymbolView name="plus" size={20} tintColorClassName="accent-icon" type="monochrome" />
    </Pressable>
  );
}

function FilterButton(props: {
  readonly active?: boolean;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      className={
        props.active
          ? "min-h-9 flex-1 items-center justify-center rounded-full bg-primary px-3"
          : "min-h-9 flex-1 items-center justify-center rounded-full bg-subtle px-3"
      }
      onPress={props.onPress}
    >
      <Text
        className={
          props.active
            ? "text-xs font-t3-bold text-primary-foreground"
            : "text-xs font-t3-bold text-foreground"
        }
        numberOfLines={1}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function ScheduleListRow(props: { readonly row: ScheduleRow; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={`${props.row.name}, ${STATE_TONES[props.row.state].label}`}
      accessibilityRole="button"
      className={
        props.row.offline ? "rounded-[22px] bg-card p-4 opacity-50" : "rounded-[22px] bg-card p-4"
      }
      onPress={props.onPress}
    >
      <View className="flex-row items-start gap-3">
        <View className="min-w-0 flex-1 gap-1.5">
          <View className="flex-row items-center gap-2">
            <Text className="min-w-0 flex-1 text-lg font-t3-bold text-foreground" numberOfLines={1}>
              {props.row.name}
            </Text>
            {props.row.hasFailureAttention ? (
              <View className="size-2.5 rounded-full bg-danger" />
            ) : null}
          </View>
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {props.row.projectLabel} · {props.row.environmentLabel}
          </Text>
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {props.row.timingLabel}
          </Text>
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {props.row.nextOccurrenceLabel}
          </Text>
          {props.row.latestHistoryLabel ? (
            <Text className="text-xs text-foreground-tertiary" numberOfLines={1}>
              {props.row.latestHistoryLabel}
            </Text>
          ) : null}
          {props.row.offline ? (
            <Text className="text-xs text-foreground-tertiary">
              Unavailable · read-only cached data
            </Text>
          ) : null}
        </View>
        <View className="items-end gap-3">
          <StatusPill {...STATE_TONES[props.row.state]} size="compact" />
          <SymbolView
            name="chevron.right"
            size={15}
            tintColorClassName="accent-chevron"
            type="monochrome"
          />
        </View>
      </View>
    </Pressable>
  );
}

export function useScheduleSettingsValue(): string | undefined {
  const { environments } = useMobileScheduleOverview();
  const failures = environments.reduce(
    (count, environment) =>
      count + environment.schedules.filter((schedule) => schedule.unacknowledgedFailure).length,
    0,
  );
  return failures > 0 ? `${failures} failed` : undefined;
}
