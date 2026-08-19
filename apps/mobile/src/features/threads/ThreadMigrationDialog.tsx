import { deriveMigrationModeAvailability } from "@t3tools/client-runtime/usage/thread-migration";
import type { ThreadMigrationHandoffMode } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";

function HandoffModeRow(props: {
  readonly mode: ThreadMigrationHandoffMode;
  readonly selected: boolean;
  readonly title: string;
  readonly description: string;
  readonly disabledReason: string | null;
  readonly onSelect: (mode: ThreadMigrationHandoffMode) => void;
}) {
  const iconColor = String(useThemeColor("--color-icon"));
  const disabled = props.disabledReason !== null;
  return (
    <Pressable
      accessibilityLabel={props.title}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled }}
      className={cn(
        "flex-row gap-3 rounded-2xl border bg-card px-4 py-3",
        props.selected ? "border-primary" : "border-border",
        disabled && "opacity-50",
      )}
      disabled={disabled}
      onPress={() => props.onSelect(props.mode)}
    >
      <View
        className={cn(
          "mt-0.5 h-5 w-5 items-center justify-center rounded-full border",
          props.selected ? "border-primary bg-primary" : "border-border-strong",
        )}
      >
        {props.selected ? (
          <SymbolView name="checkmark" size={11} tintColor={iconColor} type="monochrome" />
        ) : null}
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-base font-t3-bold text-foreground">{props.title}</Text>
        <Text className="text-sm leading-5 text-foreground-muted">
          {props.disabledReason ?? props.description}
        </Text>
      </View>
    </Pressable>
  );
}

export function ThreadMigrationDialog(props: {
  readonly open: boolean;
  readonly sourceName: string;
  readonly targetName: string;
  readonly targetModel: string;
  readonly actionLabel: string;
  readonly isOriginLimited: boolean;
  readonly isTurnStreaming: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onConfirm: (handoffMode: ThreadMigrationHandoffMode) => void;
}) {
  const [handoffMode, setHandoffMode] = useState<ThreadMigrationHandoffMode>("replay");
  const iconColor = String(useThemeColor("--color-icon-muted"));
  const availability = deriveMigrationModeAvailability({
    isOriginLimited: props.isOriginLimited,
    isTurnStreaming: props.isTurnStreaming,
  });

  useEffect(() => {
    if (props.open) setHandoffMode("replay");
  }, [props.open, props.targetName, props.targetModel]);

  useEffect(() => {
    if (handoffMode === "brief" && availability.briefDisabledReason) {
      setHandoffMode("replay");
    }
  }, [availability.briefDisabledReason, handoffMode]);

  const close = () => {
    if (!props.isPending) props.onClose();
  };

  return (
    <Modal
      animationType="fade"
      navigationBarTranslucent
      onRequestClose={close}
      statusBarTranslucent
      transparent
      visible={props.open}
    >
      <View className="flex-1 justify-end bg-backdrop">
        <Pressable
          accessibilityLabel="Close thread migration"
          accessibilityRole="button"
          className="flex-1"
          onPress={close}
        />
        <View className="max-h-[82%] rounded-t-[28px] bg-sheet px-5 pb-8 pt-5">
          <View className="mb-4 flex-row items-start gap-3">
            <View className="min-w-0 flex-1 gap-1">
              <Text accessibilityRole="header" className="text-xl font-t3-bold text-foreground">
                Migrate this thread?
              </Text>
              <Text className="text-sm leading-5 text-foreground-muted">
                Move from {props.sourceName} to {props.targetName} on {props.targetModel}. Messages,
                checkpoints, diffs, and the thread identity stay in place.
              </Text>
            </View>
            <Pressable
              accessibilityLabel="Cancel thread migration"
              accessibilityRole="button"
              className="h-9 w-9 items-center justify-center rounded-full bg-subtle active:opacity-70"
              disabled={props.isPending}
              onPress={close}
            >
              <SymbolView name="xmark" size={14} tintColor={iconColor} type="monochrome" />
            </Pressable>
          </View>

          <ScrollView className="shrink" showsVerticalScrollIndicator={false}>
            <View className="gap-3">
              <View className="flex-row items-center gap-2 rounded-2xl border border-border bg-card px-4 py-3">
                <Text
                  className="min-w-0 flex-1 text-sm font-t3-bold text-foreground"
                  numberOfLines={1}
                >
                  {props.sourceName}
                </Text>
                <SymbolView
                  name="chevron.right"
                  size={14}
                  tintColor={iconColor}
                  type="monochrome"
                />
                <Text
                  className="min-w-0 flex-1 text-right text-sm font-t3-bold text-foreground"
                  numberOfLines={1}
                >
                  {props.targetName}
                </Text>
              </View>
              <Text className="text-sm font-t3-bold text-foreground">Handoff mode</Text>
              <HandoffModeRow
                mode="replay"
                selected={handoffMode === "replay"}
                title="Replay history"
                description="Reconstruct the conversation from Phoenix. This works even when the current account is limited."
                disabledReason={availability.replayDisabledReason}
                onSelect={setHandoffMode}
              />
              <HandoffModeRow
                mode="brief"
                selected={handoffMode === "brief"}
                title="Create a handoff brief"
                description="Ask the current agent to compact the thread before the new provider takes over."
                disabledReason={availability.briefDisabledReason}
                onSelect={setHandoffMode}
              />
              {availability.migrationDisabledReason ? (
                <View className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                  <Text className="text-sm leading-5 text-foreground">
                    {availability.migrationDisabledReason}
                  </Text>
                </View>
              ) : null}
              {props.error ? (
                <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                  {props.error}
                </Text>
              ) : null}
            </View>
          </ScrollView>

          <View className="mt-5 flex-row gap-3">
            <Pressable
              accessibilityRole="button"
              className="min-h-12 flex-1 items-center justify-center rounded-2xl border border-secondary-border bg-secondary px-4 disabled:opacity-45"
              disabled={props.isPending}
              onPress={close}
            >
              <Text className="font-t3-bold text-secondary-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              className="min-h-12 flex-[1.4] items-center justify-center rounded-2xl bg-primary px-4 disabled:opacity-45"
              disabled={props.isPending || availability.migrationDisabledReason !== null}
              onPress={() => props.onConfirm(handoffMode)}
            >
              <Text className="text-center font-t3-bold text-primary-foreground">
                {props.isPending ? "Switching…" : props.actionLabel}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
