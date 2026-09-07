import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { AgentsIcon } from "./NavigationIcons";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { useContext, useEffect, useRef, useState } from "react";
import { NavigationContext, useIsFocused } from "@react-navigation/native";
import { AccessibilityInfo, Animated, AppState, Easing, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { resolveThreadListV2Status } from "../features/threads/threadListV2";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProviderIcon } from "./ProviderIcon";
import { useNavigationColors } from "./useNavigationColors";

/** Spoken identity for rows and dialogs that group the decorative avatar. */
export function threadIdentityLabel(thread: EnvironmentThreadShell, providerDriver: string | null) {
  const status = effectiveSnoozed(thread, { now: new Date().toISOString() })
    ? "snoozed"
    : resolveThreadListV2Status(thread);
  const label = {
    snoozed: "Snoozed",
    working: "Working",
    approval: "Awaiting approval",
    input: "Awaiting input",
    "awaiting-parent": "Waiting on parent",
    failed: "Failed",
    ready: "Ready",
  }[status];
  return [label, providerDriver, thread.modelSelection.model].filter(Boolean).join(", ");
}

/** Reuses the row's real project identity and provider badge at either row or modal size. */
export function ThreadAvatar({
  thread,
  project,
  providerDriver,
  size = 30,
}: {
  thread: EnvironmentThreadShell;
  project: EnvironmentProject | null;
  providerDriver: string | null;
  size?: number;
}) {
  const colors = useNavigationColors();
  const status = effectiveSnoozed(thread, { now: new Date().toISOString() })
    ? "snoozed"
    : resolveThreadListV2Status(thread);
  const ring =
    {
      snoozed: colors.snooze,
      working: colors.dark ? "#38bdf8" : colors.accent,
      approval: colors.dark ? "#fbbf24" : "#b45309",
      input: colors.dark ? "#a5b4fc" : "#4f46e5",
      "awaiting-parent": colors.dark ? "#a5b4fc" : "#4f46e5",
      failed: colors.danger,
      ready: colors.dark ? "#34d399" : "#047857",
    }[status] ?? colors.muted;
  const scale = size / 30;
  return (
    <View
      accessible
      accessibilityLabel={threadIdentityLabel(thread, providerDriver)}
      style={{
        // Provider/status badges intentionally overflow the avatar slot.
        width: size + 2 * scale,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        paddingRight: 2 * scale,
      }}
    >
      <View
        style={{
          width: size * 0.8,
          height: size * 0.8,
          borderRadius: size,
          borderWidth: scale,
          borderColor: colors.border,
          backgroundColor: colors.surface,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {project ? (
          <ProjectFavicon
            environmentId={thread.environmentId}
            faviconPath={project.faviconPath}
            projectTitle={project.title}
            workspaceRoot={project.workspaceRoot}
            size={size * 0.54}
          />
        ) : providerDriver ? (
          <ProviderIcon provider={providerDriver} size={size * 0.54} />
        ) : (
          <AgentsIcon color={colors.muted} size={size * 0.54} />
        )}
      </View>
      <Svg
        width={size}
        height={size}
        viewBox="0 0 30 30"
        style={{ position: "absolute", left: 0, top: 0 }}
      >
        <Circle
          cx={15}
          cy={15}
          r={13.75}
          fill="none"
          stroke={ring}
          strokeWidth={1.5}
          opacity={status === "working" ? 0.22 : 0.8}
        />
      </Svg>
      {status === "working" ? <WorkingArc size={size} color={ring} /> : null}
      {providerDriver && project ? (
        <View
          style={{
            position: "absolute",
            right: 0,
            bottom: -2 * scale,
            width: 14 * scale,
            height: 14 * scale,
            borderRadius: size,
            borderWidth: scale,
            borderColor: colors.border,
            backgroundColor: colors.surface,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <ProviderIcon provider={providerDriver} size={10 * scale} />
        </View>
      ) : null}
      {status !== "working" && status !== "ready" ? (
        <View
          style={{
            position: "absolute",
            left: -2 * scale,
            bottom: -2 * scale,
            width: 14 * scale,
            height: 14 * scale,
            borderRadius: size,
            borderWidth: scale,
            borderColor: colors.surface,
            backgroundColor: ring,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Svg
            width={10 * scale}
            height={10 * scale}
            viewBox="0 0 24 24"
            fill="none"
            stroke="#ffffff"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {status === "approval" || status === "snoozed" ? (
              <Circle cx={12} cy={12} r={10} />
            ) : null}
            <Path d={statusBadgePath[status]} />
          </Svg>
        </View>
      ) : null}
    </View>
  );
}

/** Rotate only the arc, on the native driver; identity and attention badges stay still. */
function WorkingArc(props: { size: number; color: string }) {
  const navigation = useContext(NavigationContext);
  // Global confirmation dialogs live outside the navigation container.
  return navigation ? <FocusedWorkingArc {...props} /> : <AnimatedWorkingArc {...props} focused />;
}

function FocusedWorkingArc(props: { size: number; color: string }) {
  const focused = useIsFocused();
  return <AnimatedWorkingArc {...props} focused={focused} />;
}

function AnimatedWorkingArc({
  size,
  color,
  focused,
}: {
  size: number;
  color: string;
  focused: boolean;
}) {
  const rotation = useRef(new Animated.Value(0)).current;
  const [active, setActive] = useState(AppState.currentState === "active");
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (mounted) setReduceMotion(value);
    });
    const motion = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    const app = AppState.addEventListener("change", (state) => setActive(state === "active"));
    return () => {
      mounted = false;
      motion.remove();
      app.remove();
    };
  }, []);
  useEffect(() => {
    rotation.setValue(0);
    if (!focused || !active || reduceMotion) return;
    const animation = Animated.loop(
      Animated.timing(rotation, {
        toValue: 1,
        duration: 1200,
        easing: Easing.linear,
        useNativeDriver: true,
        isInteraction: false,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [active, focused, reduceMotion, rotation]);
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: size,
        height: size,
        transform: [
          { rotate: rotation.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) },
        ],
      }}
    >
      <Svg width={size} height={size} viewBox="0 0 30 30">
        <Path
          d="M15 1.25a13.75 13.75 0 0 1 13.75 13.75"
          fill="none"
          stroke={color}
          strokeWidth={1.8}
          strokeLinecap="round"
        />
      </Svg>
    </Animated.View>
  );
}

// Lucide ISC vectors used by desktop SidebarTeamAvatars.
const statusBadgePath = {
  failed: "M18 6 6 18m0-12 12 12",
  approval: "M12 8v4m0 4h.01",
  input:
    "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
  "awaiting-parent":
    "M5 22h14M5 2h14M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2",
  snoozed: "M12 6v6l4 2",
};
