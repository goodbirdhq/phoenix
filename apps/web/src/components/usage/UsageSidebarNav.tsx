import { lazy, Suspense, useMemo, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { LayoutGridIcon, SearchIcon, ListFilterIcon, PlusIcon } from "lucide-react";
import { buildUsageAccounts, usageAccountMemberKey } from "@t3tools/client-runtime/usage/accounts";
import { subscriptionAvailabilitySources } from "@t3tools/client-runtime/usage/usage-warning";
import { deriveSubscriptionLimits } from "@t3tools/client-runtime/usage/subscription-availability";
import { EnvironmentId } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuCheckboxItem } from "../ui/menu";
import { useProviderAvailability, useUsageSidebarHistory } from "../../state/usage";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  useSidebar,
} from "../ui/sidebar";
import { SidebarChromeFooter } from "../sidebar/SidebarChrome";
import { PROVIDER_PRESENTATION } from "./usageProviders";
import { scopeAccountHistory } from "@t3tools/client-runtime/usage/account-history";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { sidebarQuotaPresentation } from "./usageSidebarPresentation";
import { usageProviderKind } from "./usageAccountPresentation";

const AddProviderInstanceDialog = lazy(() =>
  import("../settings/AddProviderInstanceDialog").then((module) => ({
    default: module.AddProviderInstanceDialog,
  })),
);

export function UsageSidebarNav() {
  const environments = useProviderAvailability();
  const history = useUsageSidebarHistory();
  const accounts = useMemo(
    () =>
      buildUsageAccounts(environments, history).toSorted(
        (a, b) =>
          ["codex", "claude", "opencode", "grok"].indexOf(usageProviderKind(a.driver)) -
          ["codex", "claude", "opencode", "grok"].indexOf(usageProviderKind(b.driver)),
      ),
    [environments, history],
  );
  const costs = useMemo(
    () =>
      new Map(
        accounts.map((account) => {
          const scoped = history.flatMap((environment) =>
            environment.summary
              ? [
                  {
                    ...environment,
                    summary: scopeAccountHistory(
                      environment.summary,
                      environment.environmentId,
                      account,
                    ),
                  },
                ]
              : [],
          );
          return [
            account.key,
            scoped.some((environment) => environment.summary.sources.length > 0)
              ? mergeUsage(scoped, USAGE_CONTRACT_VERSION).costUsd
              : null,
          ];
        }),
      ),
    [accounts, history],
  );
  const [search, setSearch] = useState("");
  const [driverFilter, setDriverFilter] = useState<string | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const visibleAccounts = accounts.filter(
    (account) =>
      (!driverFilter || account.driver === driverFilter) &&
      [
        account.name,
        account.driver,
        ...account.memberships.map((member) => member.environmentLabel),
      ].some((value) => value.toLowerCase().includes(search.trim().toLowerCase())),
  );
  const connectedEnvironments = environments.filter((environment) => environment.isConnected);
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
      <div className="flex h-[52px] shrink-0 items-center gap-1 px-4 py-2.5">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-sidebar-muted-foreground focus-within:ring-2 focus-within:ring-ring">
          <SearchIcon className="size-4 shrink-0" />
          <input
            aria-label="Search accounts"
            placeholder="Search accounts"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground"
          />
        </label>
        <Menu>
          <MenuTrigger
            render={
              <Button size="icon" variant="ghost" className="size-8" aria-label="Filter accounts" />
            }
          >
            <ListFilterIcon
              className={driverFilter ? "text-primary" : "text-sidebar-muted-foreground"}
            />
          </MenuTrigger>
          <MenuPopup>
            <MenuCheckboxItem
              checked={driverFilter === null}
              onCheckedChange={() => setDriverFilter(null)}
            >
              All providers
            </MenuCheckboxItem>
            {[...new Set(accounts.map((account) => account.driver))].map((driver) => (
              <MenuCheckboxItem
                key={driver}
                checked={driverFilter === driver}
                onCheckedChange={() => setDriverFilter(driver)}
              >
                {PROVIDER_PRESENTATION[usageProviderKind(driver)].label}
              </MenuCheckboxItem>
            ))}
          </MenuPopup>
        </Menu>
        {connectedEnvironments.length === 1 ? (
          <Button
            size="icon"
            variant="outline"
            className="size-8 border-sky-600/20 bg-sky-600/10 text-sky-600 [&_svg]:text-sky-600"
            aria-label="Add provider account"
            onClick={() => setAddingTo(connectedEnvironments[0]!.environmentId)}
          >
            <PlusIcon className="size-4.5" style={{ color: "var(--color-sky-600, #0284c7)" }} />
          </Button>
        ) : (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon"
                  variant="outline"
                  className="size-8 border-sky-600/20 bg-sky-600/10 text-sky-600 [&_svg]:text-sky-600"
                  aria-label="Add provider account"
                  disabled={connectedEnvironments.length === 0}
                />
              }
            >
              <PlusIcon className="size-4.5" style={{ color: "var(--color-sky-600, #0284c7)" }} />
            </MenuTrigger>
            <MenuPopup>
              {connectedEnvironments.map((environment) => (
                <MenuItem
                  key={environment.environmentId}
                  onClick={() => setAddingTo(environment.environmentId)}
                >
                  Add account on {environment.label}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        )}
      </div>
      <SidebarContent>
        <SidebarGroup className="px-2.5 py-3">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={!selected}
                onClick={() => select()}
                className="h-auto gap-3 p-3 text-sidebar-foreground data-[active=true]:bg-sidebar-border"
              >
                <LayoutGridIcon
                  className="size-5"
                  strokeWidth={1.5}
                  style={{ color: "var(--sidebar-foreground)" }}
                />
                <span className="flex flex-col gap-[3px]">
                  <span className="text-base leading-5 font-medium">All accounts</span>
                  <span className="text-xs leading-4 font-normal text-sidebar-muted-foreground">
                    {accounts.length} {accounts.length === 1 ? "account" : "accounts"} ·{" "}
                    {environments.length}{" "}
                    {environments.length === 1 ? "environment" : "environments"}
                  </span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <div className="px-3 pt-6 pb-3 text-[11px] leading-[14px] tracking-[0.06em] text-sidebar-muted-foreground">
            PROVIDER ACCOUNTS
          </div>
          <SidebarMenu className="gap-1.5">
            {visibleAccounts.map((account) => {
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
              const quota = sidebarQuotaPresentation(kind, limit?.availability);
              const refreshing = account.memberships.some((member) =>
                environments.some(
                  (environment) =>
                    environment.environmentId === member.environmentId &&
                    environment.refreshingInstanceIds.includes(member.provider.instanceId),
                ),
              );
              const offline = account.memberships.every((member) => member.isConnected === false);
              const signedOut = account.memberships.every(
                (member) => member.provider.auth.status !== "authenticated",
              );
              const status = offline
                ? "Environment offline"
                : refreshing
                  ? "Checking limits…"
                  : signedOut
                    ? "Sign in to view limits"
                    : quota.status;
              const cost = costs.get(account.key);
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
                    className="h-auto flex-col items-stretch gap-[9px] p-3 text-sidebar-foreground data-[active=true]:bg-sidebar-border"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <Mark className="size-5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-sm leading-5 font-medium">
                        {account.name || label}
                      </span>
                      <span
                        className="w-16 shrink-0 text-right text-xs leading-4 font-normal tabular-nums text-sidebar-muted-foreground"
                        aria-label={`Estimated API cost for the selected period and environment: ${cost == null ? "unavailable" : formatUsd(cost)}`}
                      >
                        {cost == null ? "—" : formatUsd(cost)}
                      </span>
                    </span>
                    <span className="flex flex-col gap-[5px] pl-8 whitespace-normal">
                      {quota.bars.map((bar) => (
                        <span className="flex items-center gap-2" key={bar.label}>
                          <span className="w-[83px] shrink-0 text-[11px] leading-4 font-normal text-sidebar-muted-foreground">
                            {bar.label}
                          </span>
                          <span
                            className="h-1 min-w-0 flex-1 overflow-hidden rounded-[3px] bg-sidebar-border"
                            role="progressbar"
                            aria-label={`${account.name} · ${bar.label}`}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={bar.usedPercent}
                            aria-valuetext={`${Math.round(bar.usedPercent)}% used${limit?.isCurrentAvailabilityUnknown || limit?.availability.stale ? " (last known)" : ""}`}
                          >
                            <span
                              className="block h-full rounded-[3px]"
                              style={{
                                width: `${bar.usedPercent}%`,
                                backgroundColor: bar.spark
                                  ? "var(--color-sky-600, #0284c7)"
                                  : color,
                              }}
                            />
                          </span>
                          <span className="w-7 shrink-0 text-right text-[11px] leading-4 font-normal tabular-nums text-sidebar-muted-foreground">
                            {Math.round(bar.usedPercent)}%
                          </span>
                        </span>
                      ))}
                      {status && (
                        <span
                          className={
                            quota.warning && !offline && !refreshing
                              ? "text-[11px] leading-4 font-normal text-amber-700 dark:text-amber-500"
                              : "text-[11px] leading-4 font-normal text-sidebar-muted-foreground"
                          }
                        >
                          {status}
                        </span>
                      )}
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
          {visibleAccounts.length === 0 && (
            <p className="px-2 py-3 text-xs text-sidebar-muted-foreground">
              {environments.some((environment) => environment.isPending)
                ? "Loading accounts…"
                : accounts.length > 0
                  ? "No matching accounts"
                  : "No enabled accounts"}
            </p>
          )}
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
      {addingTo && (
        <Suspense fallback={null}>
          <AddProviderInstanceDialog
            open
            environmentId={EnvironmentId.make(addingTo)}
            environmentLabel={
              environments.find((environment) => environment.environmentId === addingTo)?.label ??
              "Environment"
            }
            onOpenChange={(open) => {
              if (!open) setAddingTo(null);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
