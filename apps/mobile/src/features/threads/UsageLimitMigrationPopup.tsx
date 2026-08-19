import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { memo } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";

export interface UsageLimitMigrationTarget {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
  readonly model: string;
  readonly remainingQuotaPercent: number | null;
}

function PopupAction(props: {
  readonly label: string;
  readonly primary?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      className={cn(
        "min-h-11 items-center justify-center rounded-2xl px-3 disabled:opacity-45",
        props.primary ? "bg-primary" : "border border-secondary-border bg-secondary",
      )}
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <Text
        className={cn(
          "text-center text-sm font-t3-bold",
          props.primary ? "text-primary-foreground" : "text-secondary-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export const UsageLimitMigrationPopup = memo(function UsageLimitMigrationPopup(props: {
  readonly originName: string;
  readonly resetLabel: string | null;
  readonly targets: ReadonlyArray<UsageLimitMigrationTarget>;
  readonly selectedTarget: UsageLimitMigrationTarget | null;
  readonly failedTurnCanRetry: boolean;
  readonly retryUnavailableReason: string | null;
  readonly isTurnStreaming: boolean;
  readonly streamingDisabledReason: string | null;
  readonly isBulkPending: boolean;
  readonly onSelectTarget: (instanceId: ProviderInstanceId) => void;
  readonly onSwitchAndRetry: () => void;
  readonly onSwitchOnly: () => void;
  readonly onSwitchAll: () => void;
}) {
  const iconColor = String(useThemeColor("--color-icon"));
  return (
    <View
      accessibilityLabel={`${props.originName} reached its usage limit`}
      className="absolute inset-x-0 bottom-full z-30 px-3 pb-2"
    >
      <View className="gap-3 rounded-[22px] border border-amber-500/30 bg-card p-4 shadow-lg">
        <View className="flex-row items-start gap-3">
          <View className="h-9 w-9 items-center justify-center rounded-full bg-amber-500/15">
            <SymbolView name="chart.bar.xaxis" size={17} tintColor={iconColor} type="monochrome" />
          </View>
          <View className="min-w-0 flex-1 gap-1">
            <Text accessibilityRole="header" className="text-base font-t3-bold text-foreground">
              {props.originName} reached its usage limit
            </Text>
            <Text className="text-sm leading-5 text-foreground-muted">
              Move this thread to another account and keep its history in place.
              {props.resetLabel ? ` ${props.resetLabel}.` : ""}
            </Text>
          </View>
        </View>

        {props.selectedTarget ? (
          <>
            <ScrollView
              horizontal
              contentContainerClassName="gap-2"
              showsHorizontalScrollIndicator={false}
            >
              {props.targets.map((target) => {
                const selected = target.instanceId === props.selectedTarget?.instanceId;
                return (
                  <Pressable
                    key={target.instanceId}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected, disabled: props.isTurnStreaming }}
                    className={cn(
                      "min-h-11 flex-row items-center gap-2 rounded-2xl border px-3 py-2",
                      selected ? "border-primary bg-primary/10" : "border-border bg-subtle",
                      props.isTurnStreaming && "opacity-45",
                    )}
                    disabled={props.isTurnStreaming}
                    onPress={() => props.onSelectTarget(target.instanceId)}
                  >
                    <ProviderIcon provider={target.driver} size={16} />
                    <View>
                      <Text className="text-sm font-t3-bold text-foreground">
                        {target.displayName}
                      </Text>
                      <Text className="text-2xs text-foreground-muted">
                        {target.remainingQuotaPercent === null
                          ? "Quota unknown"
                          : `${Math.round(target.remainingQuotaPercent)}% left`}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>

            <View className="flex-row gap-2">
              <View className="flex-[1.4]">
                <PopupAction
                  primary
                  label="Switch and retry"
                  disabled={!props.failedTurnCanRetry || props.isTurnStreaming}
                  onPress={props.onSwitchAndRetry}
                />
              </View>
              <View className="flex-1">
                <PopupAction
                  label="Switch only"
                  disabled={props.isTurnStreaming}
                  onPress={props.onSwitchOnly}
                />
              </View>
            </View>
            {props.isTurnStreaming && props.streamingDisabledReason ? (
              <Text className="text-xs leading-4 text-amber-700 dark:text-amber-300">
                {props.streamingDisabledReason}
              </Text>
            ) : !props.failedTurnCanRetry && props.retryUnavailableReason ? (
              <Text className="text-xs leading-4 text-foreground-muted">
                {props.retryUnavailableReason}
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              className="self-start py-1 disabled:opacity-45"
              disabled={props.isBulkPending || props.isTurnStreaming}
              onPress={props.onSwitchAll}
            >
              <Text className="text-sm font-t3-bold text-foreground-muted">
                {props.isBulkPending
                  ? "Switching active threads…"
                  : "Switch all active threads on this account"}
              </Text>
            </Pressable>
          </>
        ) : (
          <View className="rounded-2xl bg-subtle px-4 py-3">
            <Text className="text-sm text-foreground-muted">
              No other ready provider instance is available.
            </Text>
          </View>
        )}
      </View>
    </View>
  );
});
