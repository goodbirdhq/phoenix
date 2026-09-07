import {
  SettleIcon,
  SnoozeIcon,
  PinIcon,
  UnpinIcon,
  SnoozedIcon,
} from "../../components/NavigationIcons";
import type { MenuAction } from "@react-native-menu/menu";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import { useRef, useState, type RefObject } from "react";
import { Pressable, View } from "react-native";
import IconEye from "@tabler/icons-react-native/IconEye";
import IconTrash from "@tabler/icons-react-native/IconTrash";
import IconArrowBackUp from "@tabler/icons-react-native/IconArrowBackUp";
import IconArchive from "@tabler/icons-react-native/IconArchive";
import IconSparkles from "@tabler/icons-react-native/IconSparkles";
import IconChevronRight from "@tabler/icons-react-native/IconChevronRight";
import IconArrowUp from "@tabler/icons-react-native/IconArrowUp";
import IconArrowDown from "@tabler/icons-react-native/IconArrowDown";
import { ModalSlideUp } from "../../components/ModalSlideUp";
import { ThreadAvatar, threadIdentityLabel } from "../../components/ThreadAvatar";
import { AppText } from "../../components/AppText";
import { useNavigationColors } from "../../components/useNavigationColors";

const icons = {
  settle: SettleIcon,
  snooze: SnoozeIcon,
  pin: PinIcon,
  unpin: UnpinIcon,
  view: IconEye,
  delete: IconTrash,
  unsettle: IconArrowBackUp,
  archive: IconArchive,
  unsnooze: SnoozedIcon,
  "regenerate-title": IconSparkles,
  "move-pin-up": IconArrowUp,
  "move-pin-down": IconArrowDown,
};
export function ThreadActionSheet(props: {
  thread: EnvironmentThreadShell;
  project: EnvironmentProject | null;
  providerDriver: string | null;
  initialPage: "actions" | "snooze";
  actions: MenuAction[];
  returnFocusRef?: RefObject<View | null>;
  onDelete: () => Promise<boolean>;
  onAction: (id: string) => Promise<boolean>;
  onSnooze: (until: string) => Promise<boolean>;
  onClose: () => void;
  onView: () => void;
}) {
  const [page, setPage] = useState<"actions" | "snooze" | "delete">(props.initialPage);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [presets, setPresets] = useState(() => resolveSnoozePresets(new Date()));
  const colors = useNavigationColors();
  const performAction = async (action: () => Promise<boolean>, failureMessage: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      if (await action()) props.onClose();
      else setError(failureMessage);
    } catch {
      setError(failureMessage);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const choosePreset = async (id: string) => {
    if (inFlight.current) return;
    const preset = resolveSnoozePresets(new Date()).find((p) => p.id === id);
    if (!preset) {
      setPresets(resolveSnoozePresets(new Date()));
      setError("That time has passed. Choose another time.");
      return;
    }
    await performAction(
      () => props.onSnooze(preset.snoozedUntil),
      "Could not snooze this conversation. Try again.",
    );
  };
  return (
    <ModalSlideUp
      returnFocusRef={props.returnFocusRef}
      title={
        page === "delete"
          ? "Delete conversation?"
          : page === "snooze"
            ? "Snooze until"
            : props.thread.title
      }
      description={
        page !== "actions" ? props.thread.title : (props.thread.branch ?? props.project?.title)
      }
      identityLabel={threadIdentityLabel(props.thread, props.providerDriver)}
      identity={
        <ThreadAvatar
          thread={props.thread}
          project={props.project}
          providerDriver={props.providerDriver}
          size={64}
        />
      }
      busy={busy}
      onClose={props.onClose}
      footer={
        page === "delete" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={busy ? "Deleting conversation" : "Delete conversation"}
            accessibilityState={{ busy, disabled: busy }}
            disabled={busy}
            onPress={() =>
              void performAction(props.onDelete, "Could not delete this conversation. Try again.")
            }
            style={{
              minHeight: 48,
              padding: 12,
              borderRadius: 12,
              backgroundColor: "#b91c1c",
              alignItems: "center",
              justifyContent: "center",
              opacity: busy ? 0.6 : 1,
            }}
          >
            <AppText style={{ fontSize: 16, fontFamily: "DMSans-Medium", color: "#ffffff" }}>
              {busy ? "Deleting…" : "Delete conversation"}
            </AppText>
          </Pressable>
        ) : undefined
      }
    >
      <View style={{ gap: 8 }}>
        {error ? (
          <AppText accessibilityRole="alert" style={{ color: colors.danger, padding: 8 }}>
            {error}
          </AppText>
        ) : null}
        {page === "delete" ? (
          <AppText style={{ padding: 8, fontSize: 16, lineHeight: 23, color: colors.foreground }}>
            This conversation will be permanently deleted, including its terminal history.
          </AppText>
        ) : page === "snooze" ? (
          presets.map((preset) => (
            <Pressable
              key={preset.id}
              accessibilityRole="button"
              accessibilityLabel={`${preset.label}, ${preset.whenLabel}`}
              disabled={busy}
              onPress={() => void choosePreset(preset.id)}
              style={{
                minHeight: 48,
                flexDirection: "row",
                alignItems: "center",
                padding: 8,
                gap: 12,
              }}
            >
              <AppText style={{ flex: 1, fontSize: 16, color: colors.foreground }}>
                {preset.label}
              </AppText>
              <AppText style={{ fontSize: 14, color: colors.muted }}>{preset.whenLabel}</AppText>
            </Pressable>
          ))
        ) : (
          [{ id: "view", title: "View agent" }, ...props.actions].map((action) => {
            const Icon = icons[action.id as keyof typeof icons] ?? IconSparkles;
            const destructive = action.attributes?.destructive;
            const disabled = busy || action.attributes?.disabled === true;
            return (
              <Pressable
                key={action.id}
                accessibilityRole="button"
                accessibilityLabel={action.title}
                accessibilityState={{ disabled, busy }}
                disabled={disabled}
                onPress={() => {
                  if (action.id === "snooze") {
                    setPresets(resolveSnoozePresets(new Date()));
                    setPage("snooze");
                    return;
                  }
                  if (action.id === "delete") {
                    setPage("delete");
                    return;
                  }
                  if (action.id === "view") {
                    props.onClose();
                    props.onView();
                  } else {
                    void performAction(
                      () => props.onAction(action.id ?? ""),
                      `${action.title} failed. Try again.`,
                    );
                  }
                }}
                style={{
                  minHeight: 48,
                  flexDirection: "row",
                  alignItems: "center",
                  padding: 8,
                  gap: 12,
                  opacity: disabled ? 0.4 : 1,
                }}
              >
                <View style={{ width: 24, alignItems: "center" }}>
                  <Icon size={20} color={destructive ? colors.danger : colors.foreground} />
                </View>
                <AppText
                  style={{
                    flex: 1,
                    fontSize: 16,
                    color: destructive ? colors.danger : colors.foreground,
                  }}
                >
                  {action.title}
                </AppText>
                {action.id === "snooze" ? (
                  <IconChevronRight size={20} color={colors.muted} />
                ) : null}
              </Pressable>
            );
          })
        )}
      </View>
    </ModalSlideUp>
  );
}
