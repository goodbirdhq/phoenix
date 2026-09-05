import { useMemo } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ChartNoAxesCombinedIcon, ArrowLeftIcon } from "lucide-react";
import { buildUsageAccounts, usageAccountMemberKey } from "@t3tools/client-runtime/usage/accounts";
import { subscriptionAvailabilitySources } from "@t3tools/client-runtime/usage/usage-warning";
import { deriveSubscriptionLimits } from "@t3tools/client-runtime/usage/subscription-availability";
import { useProviderAvailability } from "../../state/usage";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  useSidebar,
} from "../ui/sidebar";
import { SidebarChromeFooter } from "../sidebar/SidebarChrome";
import { PROVIDER_PRESENTATION } from "./usageProviders";
import { primaryUsageWindow } from "@t3tools/client-runtime/usage/quotas";
import { usageProviderKind } from "./usageAccountPresentation";

export function UsageSidebarNav() {
  const environments = useProviderAvailability();
  const accounts = useMemo(() => buildUsageAccounts(environments, []), [environments]);
  const sources = useMemo(() => subscriptionAvailabilitySources(environments), [environments]);
  const { account: selected } = useSearch({ from: "/usage" });
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const select = (key?: string) => {
    void navigate({ to: "/usage", search: key ? { account: key } : {} });
    if (isMobile) setOpenMobile(false);
  };
  return (
    <>
      <SidebarContent>
        <SidebarGroup className="px-4 pt-4">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => {
                  void navigate({ to: "/" });
                  if (isMobile) setOpenMobile(false);
                }}
              >
                <ArrowLeftIcon />
                Back to workspace
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={!selected} onClick={() => select()}>
                <ChartNoAxesCombinedIcon />
                All accounts
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <SidebarGroupLabel className="mt-5">Accounts</SidebarGroupLabel>
          <SidebarMenu>
            {accounts.map((account) => {
              const kind = usageProviderKind(account.driver);
              const { mark: Mark, color, label } = PROVIDER_PRESENTATION[kind];
              const limits = deriveSubscriptionLimits(
                sources.filter((source) =>
                  account.memberships.some(
                    (member) =>
                      member.environmentId === source.environmentId &&
                      member.provider.instanceId === source.instanceId,
                  ),
                ),
              );
              const limit = limits[0];
              const window =
                limit && !limit.isStale && !limit.isCurrentAvailabilityUnknown
                  ? primaryUsageWindow(kind, limit.availability)
                  : undefined;
              const title = account.memberships[0]?.provider.displayName ?? label;
              return (
                <SidebarMenuItem key={account.key}>
                  <SidebarMenuButton
                    isActive={account.memberships.some(
                      (member) => usageAccountMemberKey(member) === selected,
                    )}
                    onClick={() => {
                      const member = account.memberships[0];
                      if (member) select(usageAccountMemberKey(member));
                    }}
                    className="h-auto min-h-14 items-start py-2.5"
                  >
                    <Mark className="mt-0.5 size-4 shrink-0" />
                    <span className="flex min-w-0 flex-1 flex-col gap-2">
                      <span className="truncate">{title}</span>
                      {window ? (
                        <span className="flex items-center gap-2">
                          <span className="h-1 flex-1 overflow-hidden rounded-full bg-sidebar-border">
                            <span
                              className="block h-full rounded-full"
                              style={{ width: `${window.usedPercent}%`, backgroundColor: color }}
                            />
                          </span>
                          <span className="text-[10px] text-sidebar-muted-foreground tabular-nums">
                            {Math.round(window.usedPercent)}%
                          </span>
                        </span>
                      ) : (
                        <span className="text-xs text-sidebar-muted-foreground">
                          {limit?.isStale ? "Limits need refresh" : "Limits unavailable"}
                        </span>
                      )}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
          {accounts.length === 0 && (
            <p className="px-2 py-3 text-xs text-sidebar-muted-foreground">
              {environments.some((environment) => environment.isPending)
                ? "Loading accounts…"
                : "No configured accounts"}
            </p>
          )}
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}
