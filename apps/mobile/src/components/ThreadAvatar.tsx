import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { createContext, use, useContext, useEffect, useState } from "react";
import { NavigationContext, useIsFocused } from "@react-navigation/native";
import { AccessibilityInfo, Animated, AppState, Easing, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";

import {
  resolveThreadAvatarStatus,
  threadAvatarHasStatusBadge,
  type ThreadAvatarStatus,
} from "../features/threads/thread-avatar-status";
import { SymbolView } from "./ui/AppSymbol";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProviderIcon } from "./ProviderIcon";
import { useNavigationColors } from "./useNavigationColors";

/**
 * Whether working arcs may rotate. Thread lists provide false for rows outside
 * the viewport (dormant frames), which draw the arc still and hold no motion
 * or app-state listeners; everywhere else the arc animates.
 */
export const ThreadAvatarMotionContext = createContext(true);

/**
 * The session's identity: its project icon (or, for a child session in its
 * parent's project, the provider), ringed in its status color, with the
 * provider badge bottom-right and an attention glyph bottom-left. Decorative:
 * rows speak its status through their own label.
 */
export function ThreadAvatar({
  thread,
  project,
  providerDriver,
  providerIconUrl,
  snoozed = false,
  size = 30,
}: {
  readonly thread: Parameters<typeof resolveThreadAvatarStatus>[0] &
    Pick<EnvironmentThreadShell, "environmentId">;
  readonly project: EnvironmentProject | null;
  readonly providerDriver: string | null;
  readonly providerIconUrl?: string | null | undefined;
  readonly snoozed?: boolean;
  readonly size?: number;
}) {
  const colors = useNavigationColors();
  const status = resolveThreadAvatarStatus(thread, { snoozed });
  const ring = {
    snoozed: colors.snooze,
    working: colors.dark ? "#38bdf8" : colors.accent,
    approval: colors.dark ? "#fbbf24" : "#b45309",
    limited: colors.dark ? "#fbbf24" : "#b45309",
    input: colors.dark ? "#a5b4fc" : "#4f46e5",
    waiting: colors.dark ? "#a5b4fc" : "#4f46e5",
    failed: colors.danger,
    ready: colors.dark ? "#34d399" : "#047857",
  }[status];
  const scale = size / 30;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
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
            projectIcon={project.projectIcon}
            projectTitle={project.title}
            workspaceRoot={project.workspaceRoot}
            size={size * 0.54}
          />
        ) : providerDriver ? (
          <ProviderIcon provider={providerDriver} iconUrl={providerIconUrl} size={size * 0.54} />
        ) : (
          <SymbolView
            name="folder"
            size={size * 0.5}
            tintColorClassName="accent-foreground-muted"
            type="monochrome"
          />
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
          <ProviderIcon provider={providerDriver} iconUrl={providerIconUrl} size={10 * scale} />
        </View>
      ) : null}
      {threadAvatarHasStatusBadge(status) ? (
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
            {status === "approval" || status === "limited" || status === "snoozed" ? (
              <Circle cx={12} cy={12} r={10} />
            ) : null}
            <Path d={STATUS_BADGE_PATH[status]} />
          </Svg>
        </View>
      ) : null}
    </View>
  );
}

/** Rotate only the arc, on the native driver; identity and attention badges stay still. */
function WorkingArc(props: { size: number; color: string }) {
  const motion = use(ThreadAvatarMotionContext);
  const navigation = useContext(NavigationContext);
  if (!motion) {
    return (
      <View
        pointerEvents="none"
        style={{ position: "absolute", left: 0, top: 0, width: props.size, height: props.size }}
      >
        <WorkingArcPath {...props} />
      </View>
    );
  }
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
  const [rotation] = useState(() => new Animated.Value(0));
  const [active, setActive] = useState(AppState.currentState === "active");
  // Still until the setting is known, so reduced-motion users never see a spin.
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
      <WorkingArcPath size={size} color={color} />
    </Animated.View>
  );
}

function WorkingArcPath({ size, color }: { size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 30 30">
      <Path
        d="M15 1.25a13.75 13.75 0 0 1 13.75 13.75"
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
      />
    </Svg>
  );
}

// Lucide ISC vectors used by desktop SidebarTeamAvatars.
const STATUS_BADGE_PATH: Record<Exclude<ThreadAvatarStatus, "working" | "ready">, string> = {
  failed: "M18 6 6 18m0-12 12 12",
  approval: "M12 8v4m0 4h.01",
  limited: "M12 8v4m0 4h.01",
  input:
    "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
  waiting:
    "M5 22h14M5 2h14M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2",
  snoozed: "M12 6v6l4 2",
};
