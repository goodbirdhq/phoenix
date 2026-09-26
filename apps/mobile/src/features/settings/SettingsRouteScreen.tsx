import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { SymbolView } from "../../components/AppSymbol";
import { AsyncResult } from "effect/unstable/reactivity";
import { deriveProjectGroupLabel } from "@t3tools/client-runtime/state/project-grouping";
import { type ComponentProps } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { NativeHeaderToolbar } from "../../native/StackHeader";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
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
      <SettingsRow icon="folder" label="Project Grouping" target="SettingsProjectGrouping" />
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
