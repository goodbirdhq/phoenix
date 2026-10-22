import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

export type SidebarFooterPage =
  | "settings"
  | "agents"
  | "pull-requests"
  | "schedules"
  | "usage"
  | null;

export function resolveSidebarFooterPage(pathname: string): SidebarFooterPage {
  // Upstream keeps schedules under settings; the footer treats it as its own tab.
  if (pathname === "/settings/scheduled-tasks") return "schedules";
  if (pathname === "/settings" || pathname.startsWith("/settings/")) return "settings";
  if (pathname === "/usage") return "usage";
  if (pathname === "/pull-requests") return "pull-requests";
  if (pathname.startsWith("/projects/")) return null;
  return "agents";
}

export function isSidebarUtilityPage(pathname: string) {
  return resolveSidebarFooterPage(pathname) !== "agents";
}

let mainAppHref: string | null = null;

export function MainAppLocationTracker() {
  const href = useLocation({
    select: (location) => (isSidebarUtilityPage(location.pathname) ? null : location.href),
  });
  useEffect(() => {
    if (href !== null) mainAppHref = href;
  }, [href]);
  return null;
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return () => navigate({ href: mainAppHref ?? "/" });
}
