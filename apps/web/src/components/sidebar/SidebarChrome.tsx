import { UsageHoverSummary } from "../usage/UsageHoverSummary";
import { useProviderUpdateCount } from "../../state/providerUpdates";
import {
  aggregateSchedules,
  unacknowledgedScheduleFailureCount,
} from "@t3tools/client-runtime/schedules";
import { Link, useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  CodeXmlIcon,
  BotIcon,
  KeyboardIcon,
  PaletteIcon,
  Settings2Icon,
  GitPullRequestIcon,
  ServerIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback, useEffect } from "react";

import { isElectron } from "../../env";
import { isMacPlatform } from "../../lib/utils";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator, MenuShortcut } from "../ui/menu";
import { useEnvironmentIdentificationMode, useLegacySidebarEnabled } from "../../hooks/useSettings";
import { APP_BASE_NAME } from "~/branding";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import { useWebEnvironmentSchedules } from "../../state/schedules";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  resolveSidebarStageFocusRingOffsetClass,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdateMenuItem } from "./SidebarUpdatePill";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
  plain = false,
}: {
  isElectron: boolean;
  plain?: boolean;
}) {
  const legacy = useLegacySidebarEnabled();
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    !plain && environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative shrink-0 flex-row items-center px-3 pb-0 md:px-0",
        legacy
          ? "h-[var(--workspace-topbar-height)] pt-0"
          : "h-[calc(var(--workspace-topbar-height)+14px)] pt-3.5",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarTrigger
        className={cn(
          "relative z-10 md:hidden",
          backdropVariant &&
            "focus-visible:ring-white/90 [&_svg]:stroke-white/90! [&_svg]:opacity-100! [&_svg]:hover:stroke-white! [:hover,[data-pressed]]:bg-white/15",
          backdropVariant && resolveSidebarStageFocusRingOffsetClass(backdropVariant),
        )}
      />
      <SidebarBrand onBackdrop={backdropVariant !== null} legacy={legacy} />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 hidden rounded-full px-1.5 text-muted-foreground @[15rem]/sidebar-header:inline-flex"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
    </SidebarHeader>
  );
});

function SidebarBrand({ onBackdrop, legacy }: { onBackdrop: boolean; legacy: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "relative z-10 hidden h-7 w-fit min-w-0 shrink-0 items-center gap-1 overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 md:flex",
        legacy
          ? "ml-[var(--workspace-titlebar-content-left)]"
          : "ml-[calc(var(--workspace-titlebar-content-left)+22px)]",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <span
        className={cn(
          "-translate-y-px truncate text-sm font-semibold tracking-tight",
          onBackdrop ? "text-white" : "text-foreground",
        )}
      >
        {APP_BASE_NAME}
      </span>
    </Link>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
  active = false,
  activeWidth,
  badge,
  updateCount,
  tooltipContent,
}: {
  active?: boolean;
  activeWidth: number;
  badge?: number;
  updateCount?: number;
  tooltipContent?: ReactNode;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className={cn("min-w-0", active ? "shrink" : "shrink-0")}>
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={
                badge
                  ? `${label}, ${badge} unacknowledged ${badge === 1 ? "failure" : "failures"}`
                  : updateCount
                    ? `${label}, ${updateCount} provider updates available`
                    : label
              }
              aria-current={active ? "page" : undefined}
              style={active ? { width: activeWidth } : undefined}
              onClick={onClick}
              className={cn(
                "relative h-9 w-9 @max-[316px]/sidebar-footer:w-7! @max-[316px]/sidebar-footer:px-0 group-data-[wide-label=true]/footer:w-8 justify-center rounded-[8px] p-0 text-sidebar-muted-foreground [&>svg]:size-4 [&>svg]:text-current",
                active &&
                  "w-auto group-data-[wide-label=true]/footer:w-auto max-w-full gap-1.5 bg-zinc-200 hover:bg-zinc-200 px-3 text-xs font-semibold text-zinc-800 dark:bg-zinc-800 dark:hover:bg-zinc-800 dark:text-zinc-100 [&>svg]:size-[18px]",
              )}
            >
              {icon}
              {active ? <span className="@max-[316px]/sidebar-footer:hidden">{label}</span> : null}
              {updateCount ? (
                <span
                  className="absolute -right-0.5 -top-0.5 rounded-full bg-sidebar p-0.5 text-warning"
                  aria-hidden
                >
                  <ArrowUpIcon className="size-2.5" />
                </span>
              ) : null}
              {badge ? (
                <span
                  className="absolute right-0 top-0 flex min-h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-0.5 text-[9px] font-semibold leading-none text-white"
                  aria-label={`${badge} unacknowledged failures`}
                >
                  {badge > 99 ? "99+" : badge}
                </span>
              ) : null}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup
          side="top"
          className={
            tooltipContent
              ? "rounded-[10px] [&_[data-slot=tooltip-viewport]]:p-0 [--viewport-inline-padding:0px]"
              : undefined
          }
        >
          {tooltipContent ?? label}
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

// Survives the settings sidebar replacing the conversations sidebar. Only local
// app locations are remembered, and a fresh client starts at the normal landing page.
let lastAgentsLocation = { href: "/", index: 0 };
let lastNonSettingsLocation = { href: "/", index: 0 };

function SidebarSettingsMenu({ onNavigate }: { onNavigate: () => void }) {
  const navigate = useNavigate();
  const state = useDesktopUpdateState();
  const updateAvailable =
    state?.status === "available" ||
    state?.status === "downloaded" ||
    state?.status === "downloading";
  const items = [
    { to: "/settings/general", label: "General", Icon: Settings2Icon },
    { to: "/settings/appearance", label: "Appearance", Icon: PaletteIcon },
    { to: "/settings/keybindings", label: "Keybindings", Icon: KeyboardIcon },
    { to: "/settings/providers", label: "Providers", Icon: BotIcon },
  ] as const;
  return (
    <SidebarMenuItem className="shrink-0">
      <Menu>
        <MenuTrigger
          render={
            <SidebarMenuButton
              size="icon"
              aria-label={updateAvailable ? "Settings, update available" : "Settings"}
              className="relative size-9 @max-[316px]/sidebar-footer:w-7! rounded-[8px] text-sidebar-muted-foreground [&>svg]:text-current data-popup-open:bg-zinc-200 dark:data-popup-open:bg-zinc-800"
            />
          }
        >
          <SettingsIcon className="size-4" />
          {updateAvailable ? (
            <span className="absolute right-1 top-[3px] size-[7px] rounded-full border border-sidebar bg-sky-600" />
          ) : null}
        </MenuTrigger>
        <MenuPopup
          side="top"
          align="end"
          className="w-[272px] rounded-[8px] border border-border bg-popover shadow-md backdrop-filter-none [--glass-opacity:100%]"
        >
          <MenuItem
            className="h-8 rounded-[4px] text-sm"
            onClick={() => {
              onNavigate();
              void navigate({ to: "/settings" });
            }}
          >
            <SettingsIcon className="size-4" />
            All settings…
            <MenuShortcut>
              {isElectron ? (isMacPlatform(navigator.platform) ? "⌘," : "Ctrl+,") : null}
            </MenuShortcut>
          </MenuItem>
          {items.map(({ to, label, Icon }) => (
            <MenuItem
              key={to}
              className="h-8 rounded-[4px] text-sm"
              onClick={() => {
                onNavigate();
                void navigate({ to });
              }}
            >
              <Icon className="size-4" />
              {label}
            </MenuItem>
          ))}
          {isElectron ? (
            <>
              <MenuSeparator />
              <SidebarUpdateMenuItem />
            </>
          ) : null}
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const providerUpdates = useProviderUpdateCount();
  const navigate = useNavigate();
  const router = useRouter();
  const location = useLocation();
  const { isMobile, setOpenMobile } = useSidebar();
  const currentFooterPage = useLocation({
    select: (location) =>
      /^\/settings(?:\/|$)/.test(location.pathname)
        ? "settings"
        : /^\/projects\/[^/]+\/?$/.test(location.pathname)
          ? "project-settings"
          : location.pathname === "/usage"
            ? "usage"
            : location.pathname === "/pull-requests"
              ? "pull-requests"
              : location.pathname === "/environments"
                ? "environments"
                : location.pathname === "/schedules"
                  ? "schedules"
                  : null,
  });
  useEffect(() => {
    const target = { href: location.href, index: location.state.__TSR_index };
    if (currentFooterPage !== "settings") lastNonSettingsLocation = target;
    if (currentFooterPage === null) lastAgentsLocation = target;
  }, [currentFooterPage, location.href, location.state.__TSR_index]);
  const { environments } = useEnvironments();
  const { environments: scheduleEnvironments } = useWebEnvironmentSchedules();
  const scheduleFailureCount = unacknowledgedScheduleFailureCount(
    aggregateSchedules(
      scheduleEnvironments.map((entry) => ({
        environmentId: entry.environment.environmentId,
        environmentLabel: entry.environment.label,
        source: entry.source,
        online: entry.online,
        supportsSchedules: entry.supportsSchedules,
        snapshotSequence: entry.snapshotSequence,
        schedules: entry.schedules,
      })),
    ),
  );
  // The page reads every connected server, so one of them offering pull requests is enough for
  // the link to lead somewhere.
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/pull-requests", search: { involvement: "all", state: "open" } });
  }, [closeMobileSidebar, navigate]);
  const handleUsageClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  const handleEnvironmentsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/environments" });
  }, [closeMobileSidebar, navigate]);

  const handleSchedulesClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/schedules" });
  }, [closeMobileSidebar, navigate]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    // TanStack history supplies this index; if unavailable, the comparison
    // falls through to replacing with the remembered full location.
    const distance = location.state.__TSR_index - lastNonSettingsLocation.index;
    if (lastNonSettingsLocation.href !== "/" && distance > 0) router.history.go(-distance);
    else void navigate({ href: lastNonSettingsLocation.href, replace: true });
  }, [closeMobileSidebar, navigate, router, location.state.__TSR_index]);

  return (
    <SidebarMenu
      data-wide-label={
        currentFooterPage === "environments" ||
        currentFooterPage === "pull-requests" ||
        currentFooterPage === "schedules"
      }
      className="@container/sidebar-footer group/footer flex-row items-center justify-between gap-1"
    >
      {currentFooterPage === "settings" ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton
            onClick={handleBackClick}
            className="h-9 rounded-[8px] text-xs font-medium"
          >
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<CodeXmlIcon strokeWidth={1.7} />}
            label="Agents"
            activeWidth={84}
            active={currentFooterPage === null}
            onClick={() => {
              closeMobileSidebar();
              void navigate({ href: lastAgentsLocation.href });
            }}
          />
          {pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<GitPullRequestIcon />}
              label="Pull Requests"
              activeWidth={132}
              active={currentFooterPage === "pull-requests"}
              onClick={handlePullRequestsClick}
            />
          ) : null}
          <SidebarUtilityItem
            icon={<CalendarClockIcon />}
            label="Schedules"
            activeWidth={112}
            active={currentFooterPage === "schedules"}
            onClick={handleSchedulesClick}
            badge={scheduleFailureCount}
          />
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label="Usage"
            tooltipContent={<UsageHoverSummary />}
            activeWidth={84}
            active={currentFooterPage === "usage"}
            onClick={handleUsageClick}
          />
          <SidebarUtilityItem
            icon={<ServerIcon />}
            label="Environments"
            updateCount={providerUpdates}
            activeWidth={132}
            active={currentFooterPage === "environments"}
            onClick={handleEnvironmentsClick}
          />
          <SidebarSettingsMenu onNavigate={closeMobileSidebar} />
        </>
      )}
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter className="border-t-0 px-[11px] py-2.5">
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
