import { SessionAvatar } from "./SessionAvatar";
import { useMemo, useState } from "react";
import { BotIcon } from "lucide-react";
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

export function SessionIcon({
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
  const model = provider?.models.find((entry) => entry.slug === thread.modelSelection.model);
  return (
    <div className="flex shrink-0 items-start gap-2 px-2 py-1.5">
      <SessionAvatar status={status} size={24}>
        <SessionIcon provider={provider} showBadge={props.showBadge} />
      </SessionAvatar>
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
  const children = members.slice(1);
  const visible = children.slice(0, 4);
  const overflow = children.length - visible.length;
  const steps = Math.max(0, visible.length - 1 + Number(overflow > 0));
  const width = 22 + steps * 16;
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
    <span className="relative block h-[22px] w-full">
      {visible.map((thread, index) => {
        const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
        const status = effectiveSnoozed(thread, { now: new Date().toISOString() })
          ? "snoozed"
          : resolveSidebarThreadStatus(thread);
        return (
          <span
            key={thread.id}
            className="absolute top-0 flex size-[22px] items-center justify-center rounded-full bg-sidebar ring-1 ring-sidebar"
            style={{ left: steps === 0 ? 0 : `calc((100% - 22px) * ${index / steps})` }}
          >
            <SessionAvatar status={status} size={20}>
              <SessionIcon
                provider={providers.get(instanceId)}
                showBadge={instanceBadges.get(instanceId) ?? false}
              />
            </SessionAvatar>
          </span>
        );
      })}
      {overflow > 0 ? (
        <span className="absolute right-0 top-0 flex size-[22px] items-center justify-center rounded-full border-2 border-sidebar bg-muted text-[10px] text-sidebar-muted-foreground">
          +{overflow}
        </span>
      ) : null}
    </span>
  );
  const button = (
    <button
      type="button"
      className="group/avatars relative block h-[22px] shrink-0 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ width, maxWidth: "calc(100% - 6px)" }}
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
