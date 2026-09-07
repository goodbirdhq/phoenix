import { useEffect, useRef, useState, type RefObject, type ReactNode } from "react";
import {
  AccessibilityInfo,
  findNodeHandle,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "./AppText";
import { useNavigationColors } from "./useNavigationColors";

/** One focused modal with a centred identity and a scrollable, left-aligned body. */
export function ModalSlideUp(props: {
  title: string;
  description?: string;
  identity: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  cancelText?: string;
  returnFocusRef?: RefObject<View | null>;
  busy?: boolean;
  onClose: () => void;
  onDismiss?: () => void;
}) {
  const colors = useNavigationColors();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [reduceMotion, setReduceMotion] = useState(false);
  const heading = useRef<View>(null);
  const close = useRef(props.onClose);
  close.current = props.onClose;
  const busy = useRef(props.busy);
  busy.current = props.busy;
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => subscription.remove();
  }, []);
  const returnFocusRef = props.returnFocusRef;
  useEffect(
    () => () => {
      requestAnimationFrame(() => {
        const target = returnFocusRef?.current;
        const node = target ? findNodeHandle(target) : null;
        if (node) AccessibilityInfo.setAccessibilityFocus(node);
      });
    },
    [returnFocusRef],
  );
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !busy.current,
      onMoveShouldSetPanResponder: (_, gesture) =>
        gesture.dy > 8 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderRelease: (_, gesture) => {
        if (!busy.current && gesture.dy > 48) close.current();
      },
    }),
  ).current;
  return (
    <Modal
      transparent
      visible
      animationType={reduceMotion ? "none" : "slide"}
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => {
        if (!props.busy) props.onClose();
      }}
      onDismiss={props.onDismiss}
      onShow={() => {
        const node = findNodeHandle(heading.current);
        if (node) AccessibilityInfo.setAccessibilityFocus(node);
      }}
    >
      <KeyboardAvoidingView
        style={{ flex: 1, justifyContent: "flex-end" }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Pressable
          accessibilityLabel="Dismiss dialog"
          accessibilityRole="button"
          disabled={props.busy}
          onPress={props.onClose}
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: colors.dark ? "rgba(0,0,0,0.58)" : "rgba(0,0,0,0.38)",
          }}
        />
        <View
          accessibilityViewIsModal
          importantForAccessibility="yes"
          style={{
            marginHorizontal: 8,
            marginBottom: Math.max(insets.bottom, 16),
            maxHeight: height - insets.top - Math.max(insets.bottom, 16) - 16,
            borderRadius: 28,
            backgroundColor: colors.surface,
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: 20,
            gap: 8,
          }}
        >
          <View
            {...pan.panHandlers}
            accessibilityLabel="Drag down to dismiss"
            style={{ alignItems: "center", height: 17 }}
          >
            <View
              style={{
                width: 36,
                height: 5,
                borderRadius: 3,
                backgroundColor: colors.muted,
                opacity: 0.5,
              }}
            />
          </View>
          <ScrollView
            bounces={false}
            keyboardShouldPersistTaps="handled"
            style={{ flexGrow: 0 }}
            contentContainerStyle={{ gap: 8 }}
          >
            <View
              ref={heading}
              accessible
              accessibilityRole="header"
              accessibilityLabel={[props.title, props.description].filter(Boolean).join(". ")}
              style={{
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 8,
                paddingTop: 0,
                paddingBottom: 16,
              }}
            >
              <View accessible={false} importantForAccessibility="no-hide-descendants">
                {props.identity}
              </View>
              <AppText
                style={{
                  color: colors.foreground,
                  fontSize: 20,
                  lineHeight: 29,
                  fontFamily: "DMSans-Medium",
                  textAlign: "center",
                }}
              >
                {props.title}
              </AppText>
              {props.description ? (
                <AppText
                  style={{ color: colors.muted, fontSize: 14, lineHeight: 20, textAlign: "center" }}
                >
                  {props.description}
                </AppText>
              ) : null}
            </View>
            {props.children}
          </ScrollView>
          <Pressable
            accessibilityRole="button"
            disabled={props.busy}
            onPress={props.onClose}
            style={{
              minHeight: 48,
              padding: 12,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 12,
              backgroundColor: colors.secondary,
              borderWidth: colors.dark ? 1 : 0,
              borderColor: colors.border,
              opacity: props.busy ? 0.5 : 1,
            }}
          >
            <AppText
              style={{ color: colors.foreground, fontSize: 16, fontFamily: "DMSans-Medium" }}
            >
              {props.cancelText ?? "Cancel"}
            </AppText>
          </Pressable>
          {props.footer}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
