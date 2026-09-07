import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { AgentsIcon } from "./NavigationIcons";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { resolveThreadListV2Status } from "../features/threads/threadListV2";
import { ProjectFavicon } from "./ProjectFavicon";
import { ProviderIcon } from "./ProviderIcon";
import { useNavigationColors } from "./useNavigationColors";

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
      working: colors.accent,
      approval: "#b45309",
      input: "#4f46e5",
      "awaiting-parent": "#4f46e5",
      failed: colors.danger,
      ready: colors.dark ? "#34d399" : "#047857",
    }[status] ?? colors.muted;
  const scale = size / 30;
  return (
    <View
      accessible
      accessibilityLabel={`${status}${providerDriver ? `, ${providerDriver}` : ""}, ${thread.modelSelection.model}`}
      style={{
        width: size + 2 * scale,
        height: size + 4 * scale,
        alignItems: "center",
        justifyContent: "center",
        paddingBottom: 4 * scale,
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
          strokeDasharray={status === "working" ? "2 3" : undefined}
          opacity={0.8}
        />
      </Svg>
      {providerDriver && project ? (
        <View
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
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
      ) : !project && status !== "working" ? (
        <View
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
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

// Lucide ISC vectors used by desktop SidebarTeamAvatars.
const statusBadgePath = {
  ready: "M20 6 9 17l-5-5",
  failed: "M18 6 6 18m0-12 12 12",
  approval: "M12 8v4m0 4h.01",
  input:
    "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
  "awaiting-parent":
    "M5 22h14M5 2h14M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2",
  snoozed: "M12 6v6l4 2",
};
