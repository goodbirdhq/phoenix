import { useState } from "react";
import { BotIcon } from "lucide-react";
import { type SidebarThreadSummary } from "../../types";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getTriggerDisplayModelLabel } from "../chat/providerIconUtils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarTeamAvatars(props: {
  members: readonly SidebarThreadSummary[];
  providers: ReadonlyMap<string, ProviderInstanceEntry>;
  environmentLabel: string | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { members, providers } = props;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const hasChildren = members.length > 1;
  const visible = members.slice(0, 6);
  const overflow = members.length - visible.length;
  const details = (
    <div className="flex max-w-72 flex-col gap-3 text-xs">
      {visible.map((thread) => {
        const provider = providers.get(
          thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
        );
        const model = provider?.models.find((entry) => entry.slug === thread.modelSelection.model);
        return (
          <div key={thread.id} className="flex flex-col gap-1">
            <span className="truncate font-medium">{thread.title}</span>
            <span className="text-muted-foreground">
              {model ? getTriggerDisplayModelLabel(model) : thread.modelSelection.model} ·{" "}
              {provider?.displayName ?? thread.session?.providerName}
            </span>
            <span className="truncate text-muted-foreground">
              {props.environmentLabel ?? thread.environmentId} · {thread.branch ?? "Local checkout"}
            </span>
          </div>
        );
      })}
      {hasChildren ? (
        <span className="text-muted-foreground">
          {members.length} sessions · Click to {props.expanded ? "collapse" : "expand"} team
        </span>
      ) : null}
    </div>
  );
  const avatars = (
    <>
      {visible.map((thread, index) => {
        const provider = providers.get(
          thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
        );
        return (
          <span
            key={thread.id}
            className="absolute top-0 flex size-6 items-center justify-center rounded-full border border-sidebar-border bg-sidebar-row-active"
            style={{ left: index * 18 }}
          >
            {provider ? (
              <ProviderInstanceIcon
                driverKind={provider.driverKind}
                displayName={provider.displayName}
                accentColor={provider.accentColor}
                showBadge={shouldShowInstanceBadge(provider, providers.values())}
                className="size-4"
                iconClassName="size-4"
                badgeClassName="right-[-3px] bottom-[-2px] h-[11px] min-w-3 rounded-[5px] px-0.5 text-[7px]"
              />
            ) : (
              <BotIcon className="size-4 text-sidebar-muted-foreground" />
            )}
          </span>
        );
      })}
      {overflow > 0 ? (
        <span
          className="absolute top-0 flex size-6 items-center justify-center rounded-full border border-sidebar-border bg-sidebar-row-active text-xs text-sidebar-muted-foreground"
          style={{ left: visible.length * 18 }}
        >
          +{overflow}
        </span>
      ) : null}
    </>
  );
  const button = (
    <button
      type="button"
      className="relative block h-6 shrink-0 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ width: 24 + (visible.length - 1 + (overflow > 0 ? 1 : 0)) * 18 }}
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
        <Tooltip>
          <TooltipTrigger render={<PopoverTrigger render={button} />}>{avatars}</TooltipTrigger>
          <TooltipPopup side="right" align="start">
            {details}
          </TooltipPopup>
        </Tooltip>
        <PopoverPopup side="right" align="start">
          {details}
        </PopoverPopup>
      </Popover>
    );
  return (
    <Tooltip>
      <TooltipTrigger render={button}>{avatars}</TooltipTrigger>
      <TooltipPopup side="right" align="start">
        {details}
      </TooltipPopup>
    </Tooltip>
  );
}
