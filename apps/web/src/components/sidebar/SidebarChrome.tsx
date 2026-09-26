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
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdateMenuItem } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
  plain = false,
  compact = false,
}: {
  isElectron: boolean;
  plain?: boolean;
  compact?: boolean;
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
    // The titlebar row, not a padded SidebarHeader: it aligns to the window controls.
    <div
      className={cn(
        "@container/sidebar-header relative flex shrink-0 flex-row items-center gap-2 px-3 pb-0 md:px-0",
        legacy || compact
          ? "h-[var(--workspace-topbar-height)] pt-0"
          : "h-[calc(var(--workspace-topbar-height)+14px)] pt-3.5",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <SidebarTrigger
        // Over the stage artwork: the media viewer's control-on-imagery treatment.
        variant={backdropVariant ? "media-navigation" : "ghost"}
        className="relative top-auto z-10 translate-y-0 md:hidden"
      />
      <SidebarBrand onBackdrop={backdropVariant !== null} legacy={legacy} />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 hidden @[15rem]/sidebar-header:inline-flex"
          data-environment-identification="pill"
          size="sm"
          variant="secondary"
        >
          {pillLabel}
        </Badge>
      ) : null}
    </div>
  );
});

function SidebarBrand({ onBackdrop, legacy }: { onBackdrop: boolean; legacy: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "relative z-10 hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 md:flex",
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

// Footer tab buttons are Phoenix's own look (icon tabs with an expanded active
// pill), so they are plain buttons rather than restyled SidebarMenuButtons.
const SIDEBAR_FOOTER_BUTTON_CLASS_NAME =
  "relative inline-flex h-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 [&>svg]:shrink-0";

function SidebarUtilityItem({
  icon,
  label,
  onClick,
  active = false,
  badge,
  updateCount,
  tooltipContent,
}: {
  active?: boolean;
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
            <button
              type="button"
              aria-label={
                badge
                  ? `${label}, ${badge} unacknowledged ${badge === 1 ? "failure" : "failures"}`
                  : updateCount
                    ? `${label}, ${updateCount} provider updates available`
                    : label
              }
              aria-current={active ? "page" : undefined}
              onClick={onClick}
              className={cn(
                SIDEBAR_FOOTER_BUTTON_CLASS_NAME,
                "w-9 @max-[316px]/sidebar-footer:w-7! @max-[316px]/sidebar-footer:px-0 group-data-[wide-label=true]/footer:w-8 [&>svg]:size-4",
                active &&
                  "w-auto group-data-[wide-label=true]/footer:w-auto max-w-full gap-1.5 bg-sidebar-control-surface px-3 text-xs font-semibold text-sidebar-foreground hover:bg-sidebar-control-surface [&>svg]:size-4.5",
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
                  className="absolute right-0 top-0 flex min-h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-0.5 text-4xs font-semibold leading-none text-white"
                  aria-label={`${badge} unacknowledged failures`}
                >
                  {badge > 99 ? "99+" : badge}
                </span>
              ) : null}
            </button>
          }
        />
        <TooltipPopup side="top">{tooltipContent ?? label}</TooltipPopup>
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
            <button
              type="button"
              aria-label={updateAvailable ? "Settings, update available" : "Settings"}
              className={cn(
                SIDEBAR_FOOTER_BUTTON_CLASS_NAME,
                "size-9 @max-[316px]/sidebar-footer:w-7! data-popup-open:bg-sidebar-control-surface",
              )}
            />
          }
        >
          <SettingsIcon className="size-4" />
          {updateAvailable ? (
            <span className="absolute right-1 top-[3px] size-1.75 rounded-full border border-sidebar bg-info" />
          ) : null}
        </MenuTrigger>
        <MenuPopup side="top" align="end" variant="solid" className="w-68">
          <MenuItem
            className="h-8"
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
              className="h-8"
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
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
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
      className="@container/sidebar-footer group/footer flex-row items-center justify-between"
    >
      {currentFooterPage === "settings" ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick} className="h-9">
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<CodeXmlIcon strokeWidth={1.7} />}
            label="Agents"
            active={currentFooterPage === null}
            onClick={() => {
              closeMobileSidebar();
              void navigate({ href: lastAgentsLocation.href });
            }}
          />
          {pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<PullRequestGlyph.pullRequest />}
              label="Pull Requests"
              active={currentFooterPage === "pull-requests"}
              onClick={handlePullRequestsClick}
            />
          ) : null}
          <SidebarUtilityItem
            icon={<CalendarClockIcon />}
            label="Schedules"
            active={currentFooterPage === "schedules"}
            onClick={handleSchedulesClick}
            badge={scheduleFailureCount}
          />
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label="Usage"
            tooltipContent={<UsageHoverSummary />}
            active={currentFooterPage === "usage"}
            onClick={handleUsageClick}
          />
          <SidebarUtilityItem
            icon={<ServerIcon />}
            label="Environments"
            updateCount={providerUpdates}
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
    // A plain footer rather than SidebarFooter: Phoenix's tab row keeps its own insets.
    <div data-sidebar="footer" className="flex flex-col gap-2 px-2.75 py-2.5">
      <SidebarThreadUndoNotice />
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </div>
  );
});
