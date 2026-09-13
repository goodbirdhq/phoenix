import { useAtomSet, useAtomValue } from "@effect/atom-react";
import Constants from "expo-constants";
import { useNavigation } from "@react-navigation/native";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AsyncResult } from "effect/unstable/reactivity";
import { type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { reportAtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
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
import { useThreadListV2Enabled } from "../threads/use-thread-list-v2-enabled";
import {
  type AppUpdateCheckState,
  isAppUpdateCheckAvailable,
  registerHiddenUpdateTap,
  runAppUpdateCheck,
} from "../updates/app-updates";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SessionOrchestrationSettingsRows } from "./SessionOrchestrationSettingsRows";
import {
  GENERAL_INSIGHT_SETTINGS_ROWS,
  resolveAgentAwarenessPlatformPresentation,
} from "./SettingsRouteScreen.logic";
import { useScheduleSettingsValue } from "../schedules/SchedulesRouteScreen";
import { planAutoSettleSettingsSync, type AutoSettleSettings } from "./autoSettleSettingsSync";

export function SettingsRouteScreen() {
  const navigation = useNavigation();

  return (
    <>
      <WorkspaceSidebarToolbar />
      {Platform.OS === "android" ? (
        <>
          {/* Android renders its own in-screen header instead of the native bar. */}
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Settings" onBack={() => navigation.goBack()} />
        </>
      ) : (
        <NativeStackScreenOptions
          options={{
            unstable_headerRightItems:
              Platform.OS === "ios"
                ? () => [
                    withNativeGlassHeaderItem({
                      accessibilityLabel: "Close settings",
                      icon: { name: "xmark", type: "sfSymbol" } as const,
                      identifier: "settings-close",
                      label: "",
                      onPress: () => navigation.goBack(),
                      type: "button",
                    }),
                  ]
                : undefined,
          }}
        />
      )}
      <LocalSettingsRouteScreen />
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
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection title="Configuration">
          <SettingsRow
            icon="desktopcomputer"
            label="Environments"
            value={`${environmentCount}`}
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

        <SettingsSection title="Appearance">
          <SettingsRow icon="paintbrush" label="Appearance" target="SettingsAppearance" />
        </SettingsSection>

        <LegacySettingsSection />

        <ArchivedThreadsSettingsSection />

        <AppSettingsSection />
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
  const threadListV2Enabled = useThreadListV2Enabled();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);

  return (
    <SettingsSection title="General">
      <SettingsRow icon="folder" label="Project Grouping" target="SettingsProjectGrouping" />
      <SettingsSwitchRow
        icon="arrow.up"
        label="Attention ordering"
        subtitle={
          threadListV2Enabled
            ? "Prioritize decisions, failures and unread results. Turn off for Manual ordering and drag arrangement."
            : "Turn off Legacy thread list to use attention ordering."
        }
        disabled={!AsyncResult.isSuccess(preferences) || !threadListV2Enabled}
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

/**
 * Device-local legacy toggles. Mobile has no client-settings sync, so this is
 * the counterpart of web's Settings → General → Legacy features backed by
 * mobile preferences.
 */
function LegacySettingsSection() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const threadListV2Enabled = useThreadListV2Enabled();
  const planModeEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.planModeEnabled === true;

  return (
    <View className="gap-3">
      <SettingsSection title="Legacy">
        <SettingsSwitchRow
          icon="sidebar.left"
          label="Legacy Thread List"
          value={!threadListV2Enabled}
          onValueChange={(value) => savePreferences({ legacyThreadListEnabled: value })}
        />
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

function AppSettingsSection() {
  const [updateState, setUpdateState] = useState<AppUpdateCheckState>("idle");
  const updateInFlight = useRef(false);
  const hiddenUpdateTapCount = useRef(0);

  const version = Constants.expoConfig?.version ?? "0.0.0";
  // Fall back to "production" to match resolveAppVariant in app.config.ts, so a
  // missing variant never mislabels a production build as development.
  const variant = (Constants.expoConfig?.extra?.appVariant as string | undefined) ?? "production";
  const variantLabel = variant === "production" ? "" : capitalize(variant);
  const versionLabel = variantLabel ? `${version} · ${variantLabel}` : version;
  const updateCheckAvailable = isAppUpdateCheckAvailable();
  const busy =
    updateState === "checking" || updateState === "downloading" || updateState === "restarting";

  // "Up to date" is a transient acknowledgement, not a state worth persisting —
  // return the version row to its normal, deliberately quiet state.
  useEffect(() => {
    if (updateState !== "current") return;
    const timer = setTimeout(() => setUpdateState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [updateState]);

  const checkForUpdate = useCallback(async () => {
    // `disabled={busy}` only takes effect on the next render, so two taps in the
    // same frame would both get through. The ref closes that window.
    if (updateInFlight.current) return;
    updateInFlight.current = true;
    try {
      // The user asked for this restart by tapping the version row, so it may
      // apply immediately instead of prompting.
      await runAppUpdateCheck({
        applyMode: "immediate",
        onFailure: (message) => Alert.alert("Update failed", message),
        onStateChange: setUpdateState,
      });
    } finally {
      updateInFlight.current = false;
    }
  }, []);

  const handleVersionPress = useCallback(() => {
    if (!updateCheckAvailable || updateInFlight.current) return;
    const tap = registerHiddenUpdateTap(hiddenUpdateTapCount.current);
    hiddenUpdateTapCount.current = tap.nextCount;
    if (tap.shouldCheck) {
      void checkForUpdate();
    }
  }, [checkForUpdate, updateCheckAvailable]);

  const statusLabel =
    updateState === "checking"
      ? "Checking…"
      : updateState === "downloading"
        ? "Downloading…"
        : // "ready" appears only when this check joined an in-flight background-mode
          // check; that download installs at the next backgrounding.
          updateState === "ready"
          ? "Update ready"
          : updateState === "restarting"
            ? "Restarting…"
            : updateState === "current"
              ? "Up to date"
              : null;

  const versionRow = (
    <View className="flex-row items-center gap-4 p-4">
      <SymbolView
        name="info.circle"
        size={22}
        tintColorClassName={"accent-icon"}
        type="monochrome"
        weight="regular"
      />
      <Text className="flex-1 text-lg text-foreground">Version</Text>
      <View className="items-end">
        <Text className="text-lg text-foreground-muted">{versionLabel}</Text>
        {statusLabel ? (
          <Text className="text-xs text-foreground-muted/70">{statusLabel}</Text>
        ) : null}
      </View>
    </View>
  );

  return (
    <SettingsSection title="App">
      <SettingsRow icon="internaldrive" label="Client Storage" target="SettingsClientStorage" />
      <SettingsRow
        icon="doc.on.doc"
        label="Open source licenses"
        target="SettingsOpenSourceLicenses"
      />
      <SettingsRow icon="doc.text" label="Legal" fullScreenTarget="SettingsLegal" />
      {updateCheckAvailable ? (
        <Pressable
          accessibilityLabel={`Version ${versionLabel}`}
          accessibilityRole="text"
          disabled={busy}
          onPress={handleVersionPress}
        >
          {versionRow}
        </Pressable>
      ) : (
        versionRow
      )}
    </SettingsSection>
  );
}

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function ArchivedThreadsSettingsSection() {
  return (
    <SettingsSection title="Threads">
      <SettingsRow icon="archivebox" label="Archived Threads" target="SettingsArchive" />
    </SettingsSection>
  );
}
