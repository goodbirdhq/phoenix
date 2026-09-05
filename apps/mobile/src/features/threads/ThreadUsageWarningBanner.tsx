import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ProviderIcon } from "../../components/ProviderIcon";
import { useProviderAvailability } from "../../state/usage";
import {
  deriveMobileThreadUsageWarning,
  mobileUsageWarningLabel,
  type MobileUsageWarningThread,
  usageWarningExpiryDelay,
} from "./threadUsageWarning";

/**
 * Isolated availability subscriber for the chat warning. Keeping the query in
 * this leaf means quota refreshes do not rerender the composer or thread feed.
 */
export const ThreadUsageWarningBanner = memo(function ThreadUsageWarningBanner(props: {
  readonly environmentId: string;
  readonly stackedAboveStatus: boolean;
  readonly thread: MobileUsageWarningThread;
}) {
  const environments = useProviderAvailability();
  const [dismissedKeys, setDismissedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [expiryTick, setExpiryTick] = useState(0);
  const warning = useMemo(
    () =>
      deriveMobileThreadUsageWarning({
        thread: props.thread,
        environmentId: props.environmentId,
        environments,
        dismissedKeys,
      }),
    [dismissedKeys, environments, expiryTick, props.environmentId, props.thread],
  );

  useEffect(() => {
    const delay = usageWarningExpiryDelay(warning?.resetsAt ?? null);
    if (delay === null) return;
    const timer = setTimeout(() => setExpiryTick((tick) => tick + 1), delay);
    return () => clearTimeout(timer);
  }, [expiryTick, warning?.dismissalKey, warning?.resetsAt]);

  const handleDismiss = useCallback(() => {
    if (warning === null) return;
    setDismissedKeys((keys) => new Set(keys).add(warning.dismissalKey));
  }, [warning]);

  if (warning === null) return null;
  const label = mobileUsageWarningLabel(warning);

  return (
    <View
      className={`absolute inset-x-0 bottom-full z-20 items-center px-3 ${props.stackedAboveStatus ? "pb-14" : "pb-2"}`}
      pointerEvents="box-none"
    >
      <View className="max-w-full flex-row items-center gap-2 rounded-full border border-amber-500/25 bg-card px-3 py-2 shadow-sm">
        <ProviderIcon provider={warning.driver} size={15} />
        <Text
          className="min-w-0 shrink text-sm font-t3-medium leading-snug text-foreground"
          accessibilityLiveRegion="polite"
          numberOfLines={1}
        >
          {label}
        </Text>
        <Pressable
          accessibilityLabel={`Dismiss ${warning.accountName} usage warning`}
          accessibilityRole="button"
          className="-my-1 -mr-1 h-7 w-7 shrink-0 items-center justify-center rounded-full active:bg-subtle"
          hitSlop={8}
          onPress={handleDismiss}
        >
          <SymbolView
            name="xmark"
            size={13}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </Pressable>
      </View>
    </View>
  );
});
