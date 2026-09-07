import type { ReactNode } from "react";
import {
  CircleAlertIcon,
  EyeIcon,
  HourglassIcon,
  MessageSquareIcon,
  ClockIcon,
  XIcon,
} from "lucide-react";
import type { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { cn } from "~/lib/utils";

type SessionStatus = ReturnType<typeof resolveSidebarThreadStatus> | "snoozed";
const states = {
  ready: { icon: null, label: "Ready", color: "text-emerald-700 dark:text-emerald-300" },
  approval: {
    icon: CircleAlertIcon,
    label: "Decision required",
    color: "text-amber-700 dark:text-amber-300",
  },
  input: {
    icon: MessageSquareIcon,
    label: "Input required",
    color: "text-indigo-600 dark:text-indigo-300",
  },
  failed: { icon: XIcon, label: "Failed", color: "text-red-700 dark:text-red-300" },
  "awaiting-parent": {
    icon: HourglassIcon,
    label: "Waiting on parent",
    color: "text-indigo-600 dark:text-indigo-300",
  },
  monitoring: { icon: EyeIcon, label: "Monitoring", color: "text-sky-600 dark:text-sky-400" },
  snoozed: { icon: ClockIcon, label: "Snoozed", color: "text-sidebar-muted-foreground" },
};

/** Identity stays central, provider bottom-right, and attention stays visible at the left of a stack. */
export function SessionAvatar({
  status,
  children,
  providerBadge,
  size = 30,
}: {
  status: SessionStatus;
  children: ReactNode;
  providerBadge?: ReactNode;
  size?: 20 | 24 | 30;
}) {
  const state = status === "working" ? null : states[status];
  return (
    <span
      role="img"
      aria-label={state?.label ?? "Working"}
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
          "pointer-events-none absolute inset-0 size-full",
          state?.color ?? "text-sky-600 dark:text-sky-400",
        )}
      >
        <circle
          cx="15"
          cy="15"
          r="13.75"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          opacity={status === "working" ? 0.25 : 0.8}
          strokeDasharray={status === "working" ? "2 3" : undefined}
        />
        {status === "working" ? (
          <path
            d="M15 1.25a13.75 13.75 0 0 1 13.75 13.75"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        ) : null}
      </svg>
      {state?.icon ? (
        <span
          className={cn(
            "absolute -bottom-0.5 -left-0.5 z-10 flex items-center justify-center rounded-full border border-current",
            "bg-current",
            size === 20 ? "size-2.5" : "size-3",
            state.color,
          )}
        >
          <state.icon
            aria-hidden
            className={cn("text-white dark:text-zinc-900", size === 20 ? "size-1.5" : "size-2")}
          />
        </span>
      ) : null}
      {providerBadge ? (
        <span className="absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full border border-sidebar-border bg-card [&>span]:size-2.5 [&_svg]:size-2.5">
          {providerBadge}
        </span>
      ) : null}
    </span>
  );
}
