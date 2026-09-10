import { threadCompletionSeenAt } from "./threadCompletionSeen";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";
import { AppState } from "react-native";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

const EMPTY_VISITS: Readonly<Record<string, string>> = {};

export function useThreadAttentionPreferences() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferences);
  const attentionFirstEnabled =
    loaded &&
    preferences.value.sidebarAttentionFirstEnabled === true &&
    preferences.value.legacyThreadListEnabled !== true;
  return {
    loaded,
    attentionFirstEnabled,
    lastVisitedAtByKey: attentionFirstEnabled
      ? (preferences.value.threadLastVisitedAtByKey ?? EMPTY_VISITS)
      : EMPTY_VISITS,
  };
}

/** A completion is seen only with its conversation visible in the foreground.
 * Record the server's completion timestamp so clock skew cannot hide future results.
 */
export function useMarkThreadCompletionSeen(
  key: string,
  completedAt: string | null,
  visible: boolean,
) {
  const { loaded, attentionFirstEnabled, lastVisitedAtByKey } = useThreadAttentionPreferences();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  useFocusEffect(
    useCallback(() => {
      if (!loaded || !attentionFirstEnabled) return;
      const markSeen = () => {
        const seenAt = threadCompletionSeenAt({
          enabled: attentionFirstEnabled,
          visible,
          foreground: AppState.currentState === "active",
          completedAt,
          lastVisitedAt: lastVisitedAtByKey[key],
        });
        if (seenAt !== null) {
          savePreferences({ threadLastVisitedAtByKey: { ...lastVisitedAtByKey, [key]: seenAt } });
        }
      };
      markSeen();
      const subscription = AppState.addEventListener("change", markSeen);
      return () => subscription.remove();
    }, [
      attentionFirstEnabled,
      completedAt,
      key,
      lastVisitedAtByKey,
      loaded,
      savePreferences,
      visible,
    ]),
  );
}
