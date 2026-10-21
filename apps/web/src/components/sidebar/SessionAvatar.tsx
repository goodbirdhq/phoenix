import type { ReactNode } from "react";
import {
  BotIcon,
  CircleAlertIcon,
  ClockIcon,
  GaugeIcon,
  HourglassIcon,
  MessageSquareIcon,
  XIcon,
} from "lucide-react";
import type { SidebarThreadStatus } from "../Sidebar.logic";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { cn } from "~/lib/utils";

export type SessionAvatarStatus = SidebarThreadStatus | "snoozed";

// Status hues follow the convention mobile and notifications use, so a
// thread reads the same everywhere: amber approval, indigo input, sky work.
const states: Record<
  SessionAvatarStatus,
  { icon: typeof XIcon | null; label: string; color: string }
> = {
  ready: { icon: null, label: "Ready", color: "text-success" },
  approval: { icon: CircleAlertIcon, label: "Decision required", color: "text-warning-foreground" },
  input: {
    icon: MessageSquareIcon,
    label: "Input required",
    color: "text-indigo-600 dark:text-indigo-300",
  },
  failed: { icon: XIcon, label: "Failed", color: "text-error" },
  limited: { icon: GaugeIcon, label: "Usage limit reached", color: "text-warning" },
  waiting: { icon: HourglassIcon, label: "Waiting", color: "text-muted-foreground" },
  working: { icon: null, label: "Working", color: "text-info" },
  snoozed: { icon: ClockIcon, label: "Snoozed", color: "text-sidebar-muted-foreground" },
};

export function sessionAvatarLabel(status: SessionAvatarStatus): string {
  return states[status].label;
}

/** Identity stays central, the provider account rides bottom-right, and
 * attention sits bottom-left so it stays visible at the left of a stack. */
export function SessionAvatar({
  status,
  children,
  providerBadge,
  size = 30,
}: {
  status: SessionAvatarStatus;
  children: ReactNode;
  providerBadge?: ReactNode;
  size?: 20 | 24 | 30;
}) {
  const state = states[status];
  const working = status === "working";
  return (
    <span
      role="img"
      aria-label={state.label}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full bg-sidebar",
        size === 20 ? "size-5" : size === 24 ? "size-6" : "size-[30px]",
      )}
    >
      <span
        className={cn(
          "flex items-center justify-center rounded-full border border-sidebar-border bg-card",
          size === 20
            ? "size-4 [&>span]:size-3 [&_svg]:size-3"
            : size === 24
              ? "size-5 [&>svg]:size-3.5"
              : "size-6 [&>svg]:size-4",
        )}
      >
        {children}
      </span>
      <svg
        aria-hidden
        viewBox="0 0 30 30"
        className={cn(
          "pointer-events-none absolute inset-0 size-full transition-colors motion-reduce:transition-none",
          state.color,
          working && "motion-safe:animate-session-working",
        )}
      >
        <circle
          cx="15"
          cy="15"
          r="13.75"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          opacity={working ? 0.25 : 0.8}
          strokeDasharray={working ? "2 3" : undefined}
        />
        {working ? (
          <path
            d="M15 1.25a13.75 13.75 0 0 1 13.75 13.75"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        ) : null}
      </svg>
      {state.icon ? (
        <span
          className={cn(
            "absolute -bottom-0.5 -left-0.5 z-10 flex items-center justify-center rounded-full border border-current bg-current",
            size === 20 ? "size-2.5" : "size-3",
            state.color,
          )}
        >
          <state.icon
            aria-hidden
            className={cn("text-white dark:text-background", size === 20 ? "size-1.5" : "size-2")}
          />
        </span>
      ) : null}
      {providerBadge ? (
        <span className="absolute -right-0.5 -bottom-0.5 flex size-3.5 items-center justify-center rounded-full border border-sidebar-border bg-card [&>span]:size-2.5 [&_svg]:size-2.5">
          {providerBadge}
        </span>
      ) : null}
    </span>
  );
}

type SessionProvider = Pick<
  ProviderInstanceEntry,
  "driverKind" | "displayName" | "accentColor" | "acpRegistryAgentId" | "acpRegistryIconUrl"
>;

export function SessionIcon({
  provider,
  showBadge,
}: {
  provider: SessionProvider | null | undefined;
  showBadge: boolean;
}) {
  return provider ? (
    <ProviderInstanceIcon
      driverKind={provider.driverKind}
      displayName={provider.displayName}
      accentColor={provider.accentColor}
      acpRegistryAgentId={provider.acpRegistryAgentId}
      acpRegistryIconUrl={provider.acpRegistryIconUrl}
      showBadge={showBadge}
      className="size-4"
      iconClassName="size-4"
      badgeClassName="right-[-3px] bottom-[-2px] h-[11px] min-w-3 rounded-sm px-0.5 text-5xs"
    />
  ) : (
    <BotIcon className="size-4 text-sidebar-muted-foreground" />
  );
}
