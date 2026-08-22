import {
  aggregateSchedules,
  unacknowledgedScheduleFailureCount,
} from "@t3tools/client-runtime/schedules";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CalendarClockIcon,
  ChartNoAxesColumnIcon,
  GitPullRequestIcon,
  ServerIcon,
  SettingsIcon,
} from "lucide-react";
import { memo, useCallback } from "react";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
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
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <SidebarHeader
      className={cn(
        "@container/sidebar-header relative h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center px-3 py-0 md:px-0",
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
      <SidebarBrand onBackdrop={backdropVariant !== null} />
      {pillLabel ? (
        <Badge
          className="relative z-10 ml-1 rounded-full px-1.5 text-muted-foreground"
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

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center gap-1 overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 md:flex",
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

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const currentFooterPage = useLocation({
    select: (location) =>
      location.pathname === "/usage"
        ? "usage"
        : location.pathname === "/environments"
          ? "environments"
          : location.pathname === "/schedules"
            ? "schedules"
            : location.pathname === "/pull-requests"
              ? "pull-requests"
              : null,
  });
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
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
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
    void navigate({ to: "/" });
  }, [closeMobileSidebar, navigate]);

  return (
    <SidebarFooter className="p-[var(--sidebar-content-inset)]">
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarMenu className="flex-row items-center">
        {currentFooterPage ? (
          <SidebarMenuItem className="min-w-0 flex-1">
            <SidebarMenuButton onClick={handleBackClick}>
              <ArrowLeftIcon />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : (
          <>
            <SidebarMenuItem className="shrink-0">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <SidebarMenuButton
                      aria-label="Settings"
                      onClick={handleSettingsClick}
                      size="icon"
                    >
                      <SettingsIcon />
                    </SidebarMenuButton>
                  }
                />
                <TooltipPopup side="top">Settings</TooltipPopup>
              </Tooltip>
            </SidebarMenuItem>
            {pullRequestsSupported ? (
              <SidebarMenuItem className="shrink-0">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <SidebarMenuButton
                        aria-label="Pull Requests"
                        onClick={handlePullRequestsClick}
                        size="icon"
                      >
                        <GitPullRequestIcon />
                      </SidebarMenuButton>
                    }
                  />
                  <TooltipPopup side="top">Pull Requests</TooltipPopup>
                </Tooltip>
              </SidebarMenuItem>
            ) : null}
            <SidebarMenuItem className="shrink-0">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <SidebarMenuButton
                      aria-label={
                        scheduleFailureCount > 0
                          ? `Schedules, ${scheduleFailureCount} unacknowledged ${scheduleFailureCount === 1 ? "failure" : "failures"}`
                          : "Schedules"
                      }
                      className="relative"
                      onClick={handleSchedulesClick}
                      size="icon"
                    >
                      <CalendarClockIcon />
                      {scheduleFailureCount > 0 ? (
                        <span className="absolute -right-0.5 -top-0.5 flex min-h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-0.5 text-[9px] font-semibold leading-none text-white">
                          {scheduleFailureCount > 99 ? "99+" : scheduleFailureCount}
                        </span>
                      ) : null}
                    </SidebarMenuButton>
                  }
                />
                <TooltipPopup side="top">Schedules</TooltipPopup>
              </Tooltip>
            </SidebarMenuItem>
            <SidebarMenuItem className="shrink-0">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <SidebarMenuButton
                      aria-label="Environments"
                      onClick={handleEnvironmentsClick}
                      size="icon"
                    >
                      <ServerIcon />
                    </SidebarMenuButton>
                  }
                />
                <TooltipPopup side="top">Environments</TooltipPopup>
              </Tooltip>
            </SidebarMenuItem>
            <SidebarMenuItem className="shrink-0">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <SidebarMenuButton aria-label="Usage" onClick={handleUsageClick} size="icon">
                      <ChartNoAxesColumnIcon />
                    </SidebarMenuButton>
                  }
                />
                <TooltipPopup side="top">Usage</TooltipPopup>
              </Tooltip>
            </SidebarMenuItem>
          </>
        )}
        <SidebarUpdatePill />
      </SidebarMenu>
    </SidebarFooter>
  );
});
