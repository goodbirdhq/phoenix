import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { SymbolView } from "../../components/AppSymbol";
import { AsyncResult } from "effect/unstable/reactivity";
import { deriveProjectGroupLabel } from "@t3tools/client-runtime/state/project-grouping";
import { type ComponentProps, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { NativeHeaderToolbar } from "../../native/StackHeader";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironments } from "../../state/environments";
import {
  DEFAULT_SERVER_SETTINGS,
  MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
} from "@t3tools/contracts";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { SessionOrchestrationSettingsRows } from "./SessionOrchestrationSettingsRows";
import {
  GENERAL_INSIGHT_SETTINGS_ROWS,
  resolveAgentAwarenessPlatformPresentation,
} from "./SettingsRouteScreen.logic";
import { useScheduleSettingsValue } from "../schedules/SchedulesRouteScreen";
import { planAutoSettleSettingsSync, type AutoSettleSettings } from "./autoSettleSettingsSync";

export function SettingsRouteScreen() {
  const navigation = useNavigation();
  const { layout } = useAdaptiveWorkspaceLayout();

  return (
    <>
      {Platform.OS === "ios" && layout.usesSplitView ? (
        <WorkspaceSidebarToolbar
          afterSidebarButton={
            <NativeHeaderToolbar.Button
              accessibilityLabel="Go back"
              icon="chevron.left"
              onPress={() => navigation.goBack()}
            />
          }
        />
      ) : null}
      <SettingsEnvironmentFilterHeader closeSettings />
      {Platform.OS === "android" ? (
        <SettingsScreen title="Settings" trailing={<AndroidSettingsEnvironmentFilter />}>
          <LocalSettingsRouteScreen />
        </SettingsScreen>
      ) : (
        <LocalSettingsRouteScreen />
      )}
    </>
  );
}

function LocalSettingsRouteScreen() {
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environmentCount = Object.keys(savedConnectionsById).length;
  const agentAwareness = resolveAgentAwarenessPlatformPresentation(Platform.OS);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection title="Connections">
          <SettingsRow
            icon="desktopcomputer"
            label="Environments"
            value={`${environmentCount}`}
            valuePosition="trailing"
            target="SettingsEnvironments"
          />
        </SettingsSection>

        <SettingsSection title="Agent activity">
          <UnavailableCapabilityRow
            icon="bell.badge"
            label="Device Notifications"
            status={agentAwareness.status}
            subtitle={agentAwareness.subtitle}
          />
          <UnavailableCapabilityRow
            icon="bolt.circle"
            label={agentAwareness.activityLabel}
            status={agentAwareness.status}
            subtitle={agentAwareness.subtitle}
          />
        </SettingsSection>

        <GeneralSettingsSection />

        <SettingsIndexSections />

        <LegacySettingsSection />
      </ScrollView>
    </View>
  );
}

function UnavailableCapabilityRow(props: {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly status: string;
  readonly subtitle: string;
}) {
  return (
    <View className="flex-row items-center gap-4 p-4 opacity-60">
      <SymbolView
        name={props.icon}
        size={22}
        tintColorClassName="accent-icon"
        type="monochrome"
        weight="regular"
      />
      <View className="min-w-0 flex-1">
        <Text className="text-lg text-foreground">{props.label}</Text>
        <Text className="text-sm text-foreground-muted">{props.subtitle}</Text>
      </View>
      <Text className="text-sm text-foreground-muted">{props.status}</Text>
    </View>
  );
}

function GeneralSettingsSection() {
  const schedulesValue = useScheduleSettingsValue();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);

  return (
    <SettingsSection title="General">
      <SettingsSwitchRow
        icon="arrow.up"
        label="Attention ordering"
        subtitle="Prioritize decisions, failures and unread results. Turn off for Manual ordering and drag arrangement."
        disabled={!AsyncResult.isSuccess(preferences)}
        value={
          AsyncResult.isSuccess(preferences) &&
          preferences.value.sidebarAttentionFirstEnabled !== false
        }
        onValueChange={(value) => savePreferences({ sidebarAttentionFirstEnabled: value })}
      />
      <SessionOrchestrationSettingsRows />
      <AutoSettleSettingsRows />
      {GENERAL_INSIGHT_SETTINGS_ROWS.map((row) => (
        <SettingsRow
          key={row.target}
          {...row}
          value={row.target === "SettingsSchedules" ? schedulesValue : undefined}
        />
      ))}
    </SettingsSection>
  );
}

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_SERVER_SETTINGS.sidebarAutoSettleAfterDays ?? 3;

/**
 * Mobile edits auto-settle defaults across connected, capable environments.
 * The first target supplies the displayed values. Applying them leaves each
 * environment's other defaults and overrides intact.
 */
function AutoSettleSettingsRows() {
  const { environments } = useEnvironments();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "server settings update",
    reportFailure: true,
  });

  const syncTargets = environments.filter(supportsSharedSettingsSync);
  const reference = syncTargets[0] ?? null;
  const referenceSettings = reference?.serverConfig?.settings ?? null;

  const [daysDraft, setDaysDraft] = useState<string | null>(null);

  if (reference === null || referenceSettings === null) {
    return null;
  }

  const writeToAll = (patch: Partial<AutoSettleSettings>) => {
    for (const environment of syncTargets) {
      void updateSettings({ environmentId: environment.environmentId, input: { patch } });
    }
  };

  const { patch: autoSettlePatch, mismatches } = planAutoSettleSettingsSync(
    { environmentId: reference.environmentId, settings: referenceSettings },
    syncTargets.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      settings: environment.serverConfig?.settings ?? null,
    })),
  );

  const afterDays = referenceSettings.sidebarAutoSettleAfterDays;
  const commitDays = () => {
    const draft = (daysDraft ?? "").trim();
    setDaysDraft(null);
    // Whole-string check so "3.5" and "3days" are rejected instead of
    // silently becoming 3 on every eligible sync target.
    const parsed = /^\d+$/.test(draft) ? Number(draft) : Number.NaN;
    if (
      Number.isInteger(parsed) &&
      parsed >= MIN_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
      parsed <= MAX_SIDEBAR_AUTO_SETTLE_AFTER_DAYS &&
      parsed !== afterDays
    ) {
      writeToAll({ sidebarAutoSettleAfterDays: parsed });
    }
  };

  return (
    <>
      <SettingsSwitchRow
        icon="arrow.triangle.branch"
        label="Auto-settle merged threads"
        value={referenceSettings.sidebarAutoSettleOnMerge}
        onValueChange={(value) => writeToAll({ sidebarAutoSettleOnMerge: value })}
      />
      <SettingsSwitchRow
        icon="clock"
        label="Auto-settle inactive threads"
        subtitle={afterDays === null ? undefined : `After ${afterDays} days without activity`}
        value={afterDays !== null}
        onValueChange={(value) =>
          writeToAll({ sidebarAutoSettleAfterDays: value ? AUTO_SETTLE_DEFAULT_DAYS : null })
        }
      />
      {afterDays !== null ? (
        <View className="flex-row items-center gap-4 border-t border-border-subtle p-4">
          <Text className="flex-1 text-lg text-foreground">Days before auto-settle</Text>
          <TextInput
            className="min-h-10 w-20 rounded-xl px-3 py-2 text-center text-base"
            keyboardType="number-pad"
            returnKeyType="done"
            value={daysDraft ?? String(afterDays)}
            onChangeText={setDaysDraft}
            onBlur={commitDays}
            onSubmitEditing={commitDays}
            accessibilityLabel="Days before auto-settle"
          />
        </View>
      ) : null}
      {mismatches.length > 0 ? (
        <View className="flex-row items-center gap-4 border-t border-border-subtle p-4">
          <View className="min-w-0 flex-1">
            <Text className="text-lg text-foreground">Auto-settle defaults differ</Text>
            <Text className="text-sm text-foreground-muted">
              {mismatches.map((mismatch) => mismatch.label).join(", ")}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              for (const mismatch of mismatches) {
                void updateSettings({
                  environmentId: mismatch.environmentId,
                  input: { patch: autoSettlePatch },
                });
              }
            }}
            className="rounded-full bg-subtle px-4 py-2 active:opacity-70"
          >
            <Text className="text-base font-t3-medium text-foreground">
              Apply auto-settle defaults
            </Text>
          </Pressable>
        </View>
      ) : null}
    </>
  );
}

function SettingsIndexSections() {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const noServerTargets = selectedTargets.length === 0;
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const scopedProjectMembers =
    selectedProject?.members
      .map((member) => member.project)
      .filter((project) =>
        selectedTargets.some((target) => target.environmentId === project.environmentId),
      ) ?? [];
  const projectLabel =
    scopedProjectMembers.length > 0
      ? deriveProjectGroupLabel({
          representative: scopedProjectMembers[0]!,
          members: scopedProjectMembers,
        })
      : (selectedProject?.label ?? "Unavailable project");
  return (
    <>
      <SettingsSection title="Interface">
        <SettingsRow icon="paintbrush" label="Appearance" target="SettingsAppearance" />
        {Platform.OS === "ios" ? (
          <SettingsRow icon="keyboard" label="Keyboard" target="SettingsKeyboard" />
        ) : null}
      </SettingsSection>

      <SettingsSection title="Projects & threads">
        {selectedProjectKey !== null ? (
          <SettingsRow
            icon="folder"
            label="Overview"
            value={projectLabel}
            target="SettingsProjectOverview"
          />
        ) : null}
        <SettingsRow icon="folder" label="Organization" target="SettingsOrganization" />
        <SettingsRow icon="text.bubble" label="Thread behavior" target="SettingsThreads" />
        <SettingsRow icon="archivebox" label="Archived Threads" target="SettingsArchive" />
      </SettingsSection>

      <SettingsSection title="Server settings">
        <SettingsRow
          icon="text.bubble"
          label="New threads"
          target="SettingsEnvironmentNewThreads"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="arrow.triangle.branch"
          label="Source control"
          target="SettingsEnvironmentSourceControl"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="text.alignleft"
          label="Agent behavior"
          target="SettingsEnvironmentAgentBehavior"
          disabled={noServerTargets}
        />
        <SettingsRow
          icon="arrow.clockwise"
          label="Maintenance"
          target="SettingsEnvironmentMaintenance"
          disabled={noServerTargets}
        />
      </SettingsSection>

      <SettingsSection title="App">
        <SettingsRow icon="info.circle" label="About Phoenix" target="SettingsAbout" />
      </SettingsSection>
    </>
  );
}

/**
 * Device-local legacy toggles. Mobile has no client-settings sync, so this is
 * the counterpart of web's Settings → General → Legacy features backed by
 * mobile preferences.
 */
function LegacySettingsSection() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const planModeEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.planModeEnabled === true;

  return (
    <View className="gap-3">
      <SettingsSection title="Legacy">
        <SettingsSwitchRow
          icon="hammer"
          label="Plan Mode"
          value={planModeEnabled}
          onValueChange={(value) => savePreferences({ planModeEnabled: value })}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Opt into retired interfaces kept for compatibility. Plan Mode restores the Build/Plan
        control; otherwise every task runs in Build mode.
      </Text>
    </View>
  );
}
