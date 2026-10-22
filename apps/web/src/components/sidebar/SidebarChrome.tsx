import { useAtomValue } from "@effect/atom-react";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  BotIcon,
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  CodeXmlIcon,
  KeyboardIcon,
  PaletteIcon,
  ServerIcon,
  Settings2Icon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect } from "react";
import { Link, useLocation, useNavigate, useRouter } from "@tanstack/react-router";

import { APP_BASE_NAME } from "~/branding";
import { isElectron } from "../../env";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { usePullRequestsSupported } from "../../state/environments";
import { primaryServerProvidersAtom } from "../../state/server";
import { collectProviderUpdateCandidates } from "../ProviderUpdateLaunchNotification.logic";
import {
  resolveEnvironmentIdentificationPillLabel,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "../ui/menu";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { resolveSidebarFooterPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import {
  type SidebarUpdate,
  SidebarUpdateArchitectureWarning,
  SidebarUpdateMenuItem,
  SidebarUpdateReleaseNotesContent,
  SidebarUpdateRunCapsule,
  useSidebarUpdate,
} from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { observeResize } from "~/lib/observeResize";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <div
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3",
        isElectron && "drag-region",
      )}
    >
      <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
        <SidebarTrigger
          variant="ghost"
          className="relative top-auto translate-y-0"
          aria-label="Toggle main sidebar"
        />
      </div>
      <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
        <SidebarBrand />
        {pillLabel ? (
          <div className="ml-1 flex h-7 items-center">
            <Badge data-environment-identification="pill" size="sm" variant="secondary">
              {pillLabel}
            </Badge>
          </div>
        ) : null}
      </div>
    </div>
  );
});

export function SidebarBrandWidthProbe({
  onWidthChange,
}: {
  onWidthChange: (width: number) => void;
}) {
  const observeWidth = (probe: HTMLDivElement) => {
    return observeResize(probe, ([entry]) => {
      if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
    });
  };

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max border-r border-transparent pr-3"
      ref={observeWidth}
    >
      <div className="ml-[var(--workspace-titlebar-content-left)] flex">
        <SidebarBrandMark />
      </div>
    </div>
  );
}

function SidebarBrand() {
  return (
    <Link
      aria-label="Go to threads"
      className="relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md text-foreground outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset md:flex"
      to="/"
    >
      <SidebarBrandMark />
    </Link>
  );
}

function SidebarBrandMark() {
  return (
    <span className="truncate text-sm font-semibold tracking-tight text-foreground">
      {APP_BASE_NAME}
    </span>
  );
}

// Footer tab buttons are Phoenix's own look (icon tabs with an expanded active
// pill), so they are plain buttons rather than restyled SidebarMenuButtons.
const SIDEBAR_FOOTER_BUTTON_CLASS_NAME =
  "relative inline-flex h-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset [&>svg]:shrink-0";

function SidebarUtilityItem({
  icon,
  label,
  onClick,
  active = false,
}: {
  active?: boolean;
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
              aria-label={label}
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
            </button>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

const SETTINGS_MENU_ITEMS = [
  { to: "/settings/general", label: "General", Icon: Settings2Icon },
  { to: "/settings/appearance", label: "Appearance", Icon: PaletteIcon },
  { to: "/settings/keybindings", label: "Keybindings", Icon: KeyboardIcon },
  { to: "/settings/providers", label: "Providers", Icon: BotIcon },
] as const;

function SidebarSettingsMenu({
  update,
  onNavigate,
}: {
  update: SidebarUpdate;
  onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const providerUpdateCount = collectProviderUpdateCandidates(providers).length;
  const trigger = (
    <MenuTrigger
      render={
        <button
          type="button"
          aria-label={[
            "Settings",
            update.desktopUpdateAvailable ? "update available" : null,
            providerUpdateCount > 0 ? `${providerUpdateCount} provider updates available` : null,
          ]
            .filter((part) => part !== null)
            .join(", ")}
          className={cn(
            SIDEBAR_FOOTER_BUTTON_CLASS_NAME,
            "size-9 @max-[316px]/sidebar-footer:w-7! data-popup-open:bg-sidebar-control-surface",
          )}
        />
      }
    >
      <SettingsIcon className="size-4" />
      {update.desktopUpdateAvailable ? (
        <span className="absolute right-1 top-[3px] size-1.75 rounded-full border border-sidebar bg-info" />
      ) : providerUpdateCount > 0 ? (
        <span
          className="absolute -right-0.5 -top-0.5 rounded-full bg-sidebar p-0.5 text-warning"
          aria-hidden
        >
          <ArrowUpIcon className="size-2.5" />
        </span>
      ) : null}
    </MenuTrigger>
  );
  return (
    <SidebarMenuItem className="shrink-0">
      <Menu>
        {update.desktopUpdateAvailable ? (
          // The dot's hover surfaces the same release notes the update row does.
          <Tooltip>
            <TooltipTrigger render={trigger} />
            <TooltipPopup side="top" variant="glass">
              <SidebarUpdateReleaseNotesContent update={update} />
            </TooltipPopup>
          </Tooltip>
        ) : (
          trigger
        )}
        <MenuPopup side="top" align="end" className="w-68">
          <MenuItem
            className="h-8"
            onClick={() => {
              onNavigate();
              void navigate({ to: "/settings" });
            }}
          >
            <SettingsIcon className="size-4" />
            All settings…
            {isElectron ? (
              <MenuShortcut>{isMacPlatform(navigator.platform) ? "⌘," : "Ctrl+,"}</MenuShortcut>
            ) : null}
          </MenuItem>
          {SETTINGS_MENU_ITEMS.map(({ to, label, Icon }) => (
            <MenuItem
              key={to}
              className="h-8"
              onClick={() => {
                onNavigate();
                void navigate({ to });
              }}
            >
              <Icon className="size-4" />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {to === "/settings/providers" && providerUpdateCount > 0 ? (
                <span
                  className="inline-flex items-center gap-0.5 text-xs text-warning"
                  aria-label={`${providerUpdateCount} provider updates available`}
                >
                  <ArrowUpIcon className="size-3" />
                  {providerUpdateCount}
                </span>
              ) : null}
            </MenuItem>
          ))}
          {update.visible ? (
            <>
              <MenuSeparator />
              <SidebarUpdateMenuItem update={update} />
            </>
          ) : null}
        </MenuPopup>
      </Menu>
      {update.confirmDialog}
    </SidebarMenuItem>
  );
}

// Survives the settings sidebar replacing the conversations sidebar. Only local
// app locations are remembered, and a fresh client starts at the normal landing page.
let lastNonSettingsLocation = { href: "/", index: 0 };

function NonSettingsLocationTracker() {
  const location = useLocation();
  const isSettings = resolveSidebarFooterPage(location.pathname) === "settings";
  const index = location.state.__TSR_index;
  useEffect(() => {
    if (!isSettings) lastNonSettingsLocation = { href: location.href, index };
  }, [isSettings, location.href, index]);
  return null;
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const router = useRouter();
  const navigateToMainApp = useNavigateToMainApp();
  const update = useSidebarUpdate();
  const { isMobile, setOpenMobile } = useSidebar();
  const currentFooterPage = useLocation({
    select: (location) => resolveSidebarFooterPage(location.pathname),
  });
  const pullRequestsSupported = usePullRequestsSupported();
  const closeMobileSidebar = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };
  const handleAgentsClick = () => {
    closeMobileSidebar();
    void navigateToMainApp();
  };
  const handlePullRequestsClick = () => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  };
  const handleSchedulesClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/settings/scheduled-tasks" });
  };
  const handleUsageClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/usage" });
  };
  const handleBackClick = () => {
    closeMobileSidebar();
    // TanStack history supplies this index; if unavailable, the comparison
    // falls through to replacing with the remembered full location.
    const distance = router.state.location.state.__TSR_index - lastNonSettingsLocation.index;
    if (lastNonSettingsLocation.href !== "/" && distance > 0) router.history.go(-distance);
    else void navigate({ href: lastNonSettingsLocation.href, replace: true });
  };

  return (
    <>
      <NonSettingsLocationTracker />
      <SidebarUpdateRunCapsule update={update} />
      <SidebarMenu
        data-wide-label={currentFooterPage === "pull-requests" || currentFooterPage === "schedules"}
        className="@container/sidebar-footer group/footer flex-row items-center justify-between"
      >
        {currentFooterPage === "settings" ? (
          <SidebarMenuItem className="min-w-0 flex-1">
            <SidebarMenuButton onClick={handleBackClick}>
              <ArrowLeftIcon />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : (
          <>
            <SidebarUtilityItem
              icon={<CodeXmlIcon strokeWidth={1.7} />}
              label="Agents"
              active={currentFooterPage === "agents"}
              onClick={handleAgentsClick}
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
            />
            <SidebarUtilityItem
              icon={<ChartNoAxesColumnIcon />}
              label="Usage"
              active={currentFooterPage === "usage"}
              onClick={handleUsageClick}
            />
            {/* The Environments page is a follow-up; until then the tab is inert. */}
            <SidebarUtilityItem icon={<ServerIcon />} label="Environments" onClick={() => {}} />
            <SidebarSettingsMenu update={update} onNavigate={closeMobileSidebar} />
          </>
        )}
      </SidebarMenu>
    </>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter>
      <SidebarThreadUndoNotice />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
