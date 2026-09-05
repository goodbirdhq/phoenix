import { useMemo, useState, type CSSProperties } from "react";
import {
  BotIcon,
  CheckIcon,
  ClockIcon,
  EyeIcon,
  HourglassIcon,
  MessageSquareIcon,
  XIcon,
  CircleAlertIcon,
} from "lucide-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { effectiveSnoozed, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { type SidebarThreadSummary } from "../../types";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { useUiStateStore } from "../../uiStateStore";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getTriggerDisplayModelLabel } from "../chat/providerIconUtils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { hasUnseenCompletion, resolveSidebarThreadStatus } from "../Sidebar.logic";
import { hasUnseenSidebarWake } from "./SidebarFilters.logic";
import { cn } from "~/lib/utils";

function SessionIcon({
  provider,
  showBadge,
}: {
  provider: ProviderInstanceEntry | undefined;
  showBadge: boolean;
}) {
  return provider ? (
    <ProviderInstanceIcon
      driverKind={provider.driverKind}
      displayName={provider.displayName}
      accentColor={provider.accentColor}
      showBadge={showBadge}
      className="size-4"
      iconClassName="size-4"
      badgeClassName="right-[-3px] bottom-[-2px] h-[11px] min-w-3 rounded-[5px] px-0.5 text-[7px]"
    />
  ) : (
    <BotIcon className="size-4 text-sidebar-muted-foreground" />
  );
}

function SessionDetailsRow(props: {
  thread: SidebarThreadSummary;
  provider: ProviderInstanceEntry | undefined;
  showBadge: boolean;
  activeThreadKey: string | null;
}) {
  const { thread, provider } = props;
  const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const visitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[key]);
  const selected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(key));
  const now = new Date().toISOString();
  const emphasized =
    selected ||
    props.activeThreadKey === key ||
    hasUnseenCompletion({ ...thread, lastVisitedAt: visitedAt }) ||
    hasUnseenSidebarWake(threadWokeAt(thread, { now }), visitedAt);
  const status = effectiveSnoozed(thread, { now }) ? "snoozed" : resolveSidebarThreadStatus(thread);
  const badges = {
    approval: { icon: CircleAlertIcon, label: "Decision required", color: "bg-[#B45309]" },
    input: { icon: MessageSquareIcon, label: "Input required", color: "bg-[#4F46E5]" },
    failed: { icon: XIcon, label: "Failed", color: "bg-[#B91C1C]" },
    "awaiting-parent": { icon: HourglassIcon, label: "Waiting on parent", color: "bg-[#4F46E5]" },
    monitoring: { icon: EyeIcon, label: "Monitoring", color: "bg-[#0284C7]" },
    snoozed: { icon: ClockIcon, label: "Snoozed", color: "bg-[#71717B]" },
    ready: { icon: CheckIcon, label: "Ready", color: "bg-[#047857]" },
  };
  const badge = status === "working" ? null : badges[status];
  const model = provider?.models.find((entry) => entry.slug === thread.modelSelection.model);
  return (
    <div className="flex shrink-0 items-start gap-2 px-2 py-1.5">
      <span className="relative flex size-6 shrink-0 items-center justify-center rounded-full border border-sidebar-border bg-popover">
        <SessionIcon provider={provider} showBadge={props.showBadge} />
        {status === "working" ? (
          <svg
            role="img"
            aria-label="Working"
            viewBox="0 0 30 30"
            className="pointer-events-none absolute -inset-[3px] size-[30px] text-[#0284C7]"
          >
            <circle
              cx="15"
              cy="15"
              r="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeDasharray="2 3"
              opacity="0.3"
            />
            <path
              d="M15 1a14 14 0 0 1 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              className="origin-center animate-spin motion-reduce:animate-none"
            />
          </svg>
        ) : badge ? (
          <span
            role="img"
            aria-label={badge.label}
            className={cn(
              "absolute -right-1 -top-1 z-20 flex size-3.5 items-center justify-center rounded-full border border-popover text-white",
              badge.color,
            )}
          >
            <badge.icon aria-hidden className="size-2.5" />
          </span>
        ) : null}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={<span />}
            className={cn(
              "truncate text-[13px] leading-[18px]",
              emphasized
                ? "font-medium text-popover-foreground"
                : "font-normal text-muted-foreground",
            )}
          >
            {thread.title}
          </TooltipTrigger>
          <TooltipPopup>{thread.title}</TooltipPopup>
        </Tooltip>
        <span className="truncate text-xs leading-4 text-muted-foreground">
          {provider?.displayName ?? thread.session?.providerName ?? "Provider unavailable"} ·{" "}
          {model ? getTriggerDisplayModelLabel(model) : thread.modelSelection.model}
        </span>
      </div>
    </div>
  );
}

export function SidebarTeamAvatars(props: {
  members: readonly SidebarThreadSummary[];
  providers: ReadonlyMap<string, ProviderInstanceEntry>;
  activeThreadKey: string | null;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const { members, providers } = props;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [hoverOpen, setHoverOpen] = useState(false);
  const instanceBadges = useMemo(
    () =>
      new Map(
        [...providers].map(([id, provider]) => [
          id,
          shouldShowInstanceBadge(provider, providers.values()),
        ]),
      ),
    [providers],
  );
  const hasChildren = members.length > 1;
  const visible = members.slice(0, 5);
  const overflow = members.length - visible.length;
  // Reserve the expanded footprint so the branch never moves. The counter
  // anchors the right edge while intermediate avatars fan out to its left.
  const steps = visible.length - 1 + Number(overflow > 0);
  const width = Math.max(hasChildren ? 42 : 24, 24 + steps * 18);
  const details =
    hoverOpen || detailsOpen ? (
      <div className="flex max-h-80 w-[350px] max-w-[calc(100vw-40px)] flex-col gap-0.5 overflow-y-auto text-xs">
        {hasChildren ? (
          <span className="px-2 py-1.5 text-muted-foreground">{members.length} sessions</span>
        ) : null}
        {members.map((thread) => {
          const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
          return (
            <SessionDetailsRow
              key={thread.id}
              thread={thread}
              provider={providers.get(instanceId)}
              showBadge={instanceBadges.get(instanceId) ?? false}
              activeThreadKey={props.activeThreadKey}
            />
          );
        })}
      </div>
    ) : null;
  const avatars = (
    <>
      {visible.map((thread, index) => {
        const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
        return (
          <span
            key={thread.id}
            aria-hidden
            className={cn(
              "pointer-events-none absolute top-0 flex size-6 items-center justify-center rounded-full border border-sidebar-border bg-sidebar-row-active transition-[left,opacity] duration-150 ease-out motion-reduce:transition-none",
              index === 0
                ? "left-[var(--rest-left)] group-hover/sidebar-row:left-[var(--open-left)] group-focus-visible/avatars:left-[var(--open-left)] group-data-[selected=true]/avatars:left-[var(--open-left)]"
                : "left-[var(--rest-left)] opacity-0 group-hover/sidebar-row:left-[var(--open-left)] group-hover/sidebar-row:opacity-100 group-focus-visible/avatars:left-[var(--open-left)] group-data-[selected=true]/avatars:left-[var(--open-left)] group-focus-visible/avatars:opacity-100 group-data-[selected=true]/avatars:opacity-100",
            )}
            style={
              {
                "--rest-left": hasChildren ? "calc(100% - 42px)" : "0px",
                "--open-left": steps === 0 ? "0px" : `calc(${index / steps} * (100% - 24px))`,
              } as CSSProperties
            }
          >
            <SessionIcon
              provider={providers.get(instanceId)}
              showBadge={instanceBadges.get(instanceId) ?? false}
            />
          </span>
        );
      })}
      {hasChildren ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute right-0 top-0 flex size-6 items-center justify-center rounded-full border border-sidebar-border bg-sidebar-row-active text-xs text-sidebar-muted-foreground transition-opacity duration-150 motion-reduce:transition-none",
            overflow === 0 &&
              "group-hover/sidebar-row:opacity-0 group-focus-visible/avatars:opacity-0 group-data-[selected=true]/avatars:opacity-0",
          )}
        >
          <span className="group-hover/sidebar-row:hidden group-focus-visible/avatars:hidden group-data-[selected=true]/avatars:hidden">
            ×{members.length}
          </span>
          <span className="hidden group-hover/sidebar-row:inline group-focus-visible/avatars:inline group-data-[selected=true]/avatars:inline">
            +{overflow}
          </span>
        </span>
      ) : null}
    </>
  );
  const button = (
    <button
      type="button"
      className="group/avatars relative block h-6 shrink-0 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ width, maxWidth: "50%" }}
      data-selected={props.selected}
      aria-label={
        hasChildren
          ? `${props.expanded ? "Collapse" : "Expand"} team, ${members.length} sessions`
          : "Session details"
      }
      {...(hasChildren ? { "aria-expanded": props.expanded } : {})}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (hasChildren) props.onToggle();
        else setDetailsOpen((open) => !open);
      }}
    />
  );
  if (!hasChildren)
    return (
      <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
        <Tooltip open={hoverOpen && !detailsOpen} onOpenChange={setHoverOpen}>
          <TooltipTrigger render={<PopoverTrigger render={button} />}>{avatars}</TooltipTrigger>
          <TooltipPopup
            side="right"
            align="start"
            className="pointer-events-auto text-left [&_[data-slot=tooltip-viewport]]:[--viewport-inline-padding:4px]"
          >
            {details}
          </TooltipPopup>
        </Tooltip>
        <PopoverPopup
          side="right"
          align="start"
          tooltipStyle
          viewportClassName="[--viewport-inline-padding:4px]"
          className="text-left"
        >
          {details}
        </PopoverPopup>
      </Popover>
    );
  return (
    <Tooltip open={hoverOpen} onOpenChange={setHoverOpen}>
      <TooltipTrigger render={button}>{avatars}</TooltipTrigger>
      <TooltipPopup
        side="right"
        align="start"
        className="pointer-events-auto text-left [&_[data-slot=tooltip-viewport]]:[--viewport-inline-padding:4px]"
      >
        {details}
      </TooltipPopup>
    </Tooltip>
  );
}
