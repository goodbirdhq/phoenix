import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { SidebarThreadSummary } from "../../types";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useUiStateStore } from "../../uiStateStore";
import { getTriggerDisplayModelLabel } from "../chat/providerIconUtils";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../ThreadHoverCard";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
} from "../Sidebar.logic";
import { SessionAvatar, SessionIcon, type SessionAvatarStatus } from "./SessionAvatar";
import { cn } from "~/lib/utils";

type TeamProvider = Pick<
  ProviderInstanceEntry,
  | "driverKind"
  | "displayName"
  | "accentColor"
  | "acpRegistryAgentId"
  | "acpRegistryIconUrl"
  | "enabled"
  | "models"
>;

const instanceIdOf = (thread: SidebarThreadSummary) =>
  thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;

function memberStatus(thread: SidebarThreadSummary, now: string): SessionAvatarStatus {
  return effectiveSnoozed(thread, { now }) ? "snoozed" : resolveSidebarThreadStatus(thread);
}

function TeamMemberDetails(props: {
  thread: SidebarThreadSummary;
  provider: TeamProvider | undefined;
  showBadge: boolean;
  now: string;
}) {
  const { thread, provider } = props;
  const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const localVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[key]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localVisitedAt);
  const unread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  const model = provider?.models.find((entry) => entry.slug === thread.modelSelection.model);
  return (
    <div className="flex min-w-0 items-start gap-2">
      <SessionAvatar status={memberStatus(thread, props.now)} size={24}>
        <SessionIcon provider={provider} showBadge={props.showBadge} />
      </SessionAvatar>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "truncate text-xs leading-4.5",
            unread ? "font-medium text-foreground" : "text-foreground/75",
          )}
        >
          {thread.title}
        </span>
        <span className="truncate text-xs leading-4">
          {provider?.displayName ?? thread.runtime?.providerName ?? "Provider unavailable"} ·{" "}
          {model ? getTriggerDisplayModelLabel(model) : thread.modelSelection.model}
        </span>
      </div>
    </div>
  );
}

/**
 * The stack on a parent row answers how many child sessions it has and how
 * they are doing; which account each runs on is named in the hover details.
 * Clicking it expands or collapses the team.
 */
export function SidebarTeamAvatars(props: {
  parent: SidebarThreadSummary;
  members: readonly SidebarThreadSummary[];
  providers: ReadonlyMap<string, TeamProvider>;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const { members, providers } = props;
  const nowMinute = useNowMinute();
  const now = `${nowMinute}:00.000Z`;
  const visible = members.slice(0, 4);
  const overflow = members.length - visible.length;
  const steps = Math.max(0, visible.length - 1 + Number(overflow > 0));
  const width = 22 + steps * 16;
  const sessions = [props.parent, ...members];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="relative block h-[22px] shrink-0 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            style={{ width, maxWidth: "calc(100% - 6px)" }}
            data-selected={props.selected}
            aria-label={`${props.expanded ? "Collapse" : "Expand"} team, ${sessions.length} sessions`}
            aria-expanded={props.expanded}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              props.onToggle();
            }}
          />
        }
      >
        <span className="relative block h-[22px] w-full">
          {visible.map((thread, index) => (
            <span
              key={thread.id}
              className="absolute top-0 flex size-[22px] items-center justify-center rounded-full bg-sidebar ring-1 ring-sidebar"
              style={{ left: steps === 0 ? 0 : `calc((100% - 22px) * ${index / steps})` }}
            >
              {/* No account badge in the stack: at 20px it competes with the
                provider glyph and the status ring, and neighbouring accounts
                often share initials. */}
              <SessionAvatar status={memberStatus(thread, now)} size={20}>
                <SessionIcon provider={providers.get(instanceIdOf(thread))} showBadge={false} />
              </SessionAvatar>
            </span>
          ))}
          {overflow > 0 ? (
            <span className="absolute top-0 right-0 flex size-[22px] items-center justify-center rounded-full border-2 border-sidebar bg-muted text-3xs text-sidebar-muted-foreground">
              +{overflow}
            </span>
          ) : null}
        </span>
      </TooltipTrigger>
      <ThreadHoverCardPopup side="right" align="start" sideOffset={4}>
        <ThreadHoverCard title={`${sessions.length} sessions`}>
          {sessions.map((thread) => {
            const provider = providers.get(instanceIdOf(thread));
            return (
              <TeamMemberDetails
                key={thread.id}
                thread={thread}
                provider={provider}
                showBadge={
                  provider !== undefined && shouldShowInstanceBadge(provider, providers.values())
                }
                now={now}
              />
            );
          })}
        </ThreadHoverCard>
      </ThreadHoverCardPopup>
    </Tooltip>
  );
}
