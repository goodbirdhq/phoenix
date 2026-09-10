import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { LayoutGridIcon, SearchIcon, ListFilterIcon, PlusIcon, InfoIcon } from "lucide-react";
import {
  buildUsageAccounts,
  usageAccountMemberKey,
  type UsageAccount,
} from "@t3tools/client-runtime/usage/accounts";
import { subscriptionAvailabilitySources } from "@t3tools/client-runtime/usage/usage-warning";
import { deriveSubscriptionLimits } from "@t3tools/client-runtime/usage/subscription-availability";
import { EnvironmentId } from "@t3tools/contracts";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuCheckboxItem } from "../ui/menu";
import {
  useProviderAvailability,
  useUsageSidebarHistory,
  type EnvironmentProviderAvailabilityStatus,
} from "../../state/usage";
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
import { mergeUsageCost } from "@t3tools/shared/usageMerge";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { sidebarQuotaPresentation } from "./usageSidebarPresentation";
import { usageProviderKind, compareUsageAccountProviders } from "./usageAccountPresentation";

const AddProviderInstanceDialog = lazy(() =>
  import("../settings/AddProviderInstanceDialog").then((module) => ({
    default: module.AddProviderInstanceDialog,
  })),
);

export function UsageSidebarNav() {
  const environments = useProviderAvailability();
  const history = useUsageSidebarHistory();
  const accounts = useMemo(
    () => buildUsageAccounts(environments, history).toSorted(compareUsageAccountProviders),
    [environments, history],
  );
  const costCache = useMemo(() => new Map<string, number | null>(), [history]);
  const costs = useMemo(
    () =>
      new Map(
        accounts.map((account) => {
          const cacheKey = JSON.stringify([
            account.driver,
            account.memberships
              .map((member) => [member.environmentId, member.provider.instanceId])
              .toSorted(),
          ]);
          if (costCache.has(cacheKey)) return [account.key, costCache.get(cacheKey)!];
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
          const cost = scoped.some((environment) => environment.summary.sources.length > 0)
            ? mergeUsageCost(scoped, USAGE_CONTRACT_VERSION)
            : null;
          costCache.set(cacheKey, cost);
          return [account.key, cost];
        }),
      ),
    [accounts, history, costCache],
  );
  const { account: selected } = useSearch({ from: "/usage" });
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const select = (key?: string) => {
    void navigate({ to: "/usage", search: key ? { account: key } : {} });
    if (isMobile) setOpenMobile(false);
  };
  return (
    <UsageSidebarNavView
      accounts={accounts}
      costs={costs}
      environments={environments}
      historyPending={history.some((environment) => environment.isPending)}
      selected={selected}
      select={select}
      footer={<SidebarChromeFooter />}
    />
  );
}

/** Presentational sidebar used by the app and the deterministic design review fixture. */
export function UsageSidebarNavView({
  accounts,
  costs,
  environments,
  historyPending,
  selected,
  select,
  footer,
}: {
  readonly accounts: readonly UsageAccount[];
  readonly costs: ReadonlyMap<string, number | null>;
  readonly environments: readonly EnvironmentProviderAvailabilityStatus[];
  readonly historyPending: boolean;
  readonly selected?: string | undefined;
  readonly select: (key?: string) => void;
  readonly footer?: ReactNode;
}) {
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
            <PlusIcon className="size-4.5" style={{ color: "#0284C7" }} />
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
              <PlusIcon className="size-4.5" style={{ color: "#0284C7" }} />
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
        <SidebarGroup className="gap-1.5 px-2.5 py-3">
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
          <div className="px-3 pt-[18px] pb-[6px] text-[11px] leading-[14px] tracking-[0.06em] text-sidebar-muted-foreground">
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
              const pending =
                !limit?.availability.windows.length &&
                account.memberships.some((member) =>
                  environments.some(
                    (environment) =>
                      environment.environmentId === member.environmentId && environment.isPending,
                  ),
                );
              const pendingBars =
                kind === "codex"
                  ? ["Codex", "Spark"]
                  : kind === "claude"
                    ? ["Weekly", "Session"]
                    : [];
              const displayedBars = pending
                ? pendingBars.map((label) => ({ label, usedPercent: 0, spark: label === "Spark" }))
                : quota.bars;
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
              const status = pending
                ? null
                : offline
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
                    aria-label={`${account.name || label}${cost == null ? "" : ` · ${formatUsd(cost)}`}${status ? ` · ${status}` : ""}${quota.bars.map((bar) => ` · ${bar.label} ${Math.round(bar.usedPercent)}% used`).join("")}`}
                    aria-busy={pending}
                    style={{ minHeight: kind === "codex" || kind === "claude" ? 90 : 69 }}
                    className="h-auto flex-col items-stretch gap-[9px] p-3 text-sidebar-foreground data-[active=true]:bg-sidebar-border"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <Mark className="size-5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-sm leading-5 font-medium">
                        {account.name || label}
                      </span>
                      {status && displayedBars.length >= 2 && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <span
                                aria-label={status}
                                tabIndex={0}
                                className="shrink-0 text-sidebar-muted-foreground"
                              />
                            }
                          >
                            <InfoIcon className="size-3" />
                          </TooltipTrigger>
                          <TooltipPopup>{status}</TooltipPopup>
                        </Tooltip>
                      )}
                      <span
                        className="w-16 shrink-0 text-right text-xs leading-4 font-normal tabular-nums text-sidebar-muted-foreground"
                        aria-label={`Estimated API cost for the selected period and environment: ${cost == null ? "unavailable" : formatUsd(cost)}`}
                      >
                        {cost == null && historyPending ? (
                          <span className="ml-auto block h-2 w-12 rounded-sm bg-sidebar-border" />
                        ) : cost == null ? (
                          "—"
                        ) : (
                          formatUsd(cost)
                        )}
                      </span>
                    </span>
                    <span className="flex flex-col gap-[5px] pl-8 whitespace-normal">
                      {displayedBars.map((bar) => (
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
                            aria-valuenow={pending ? undefined : bar.usedPercent}
                            aria-valuetext={
                              pending
                                ? "Loading limit"
                                : `${Math.round(bar.usedPercent)}% used${limit?.isCurrentAvailabilityUnknown || limit?.availability.stale ? " (last known)" : ""}`
                            }
                          >
                            <span
                              className="block h-full rounded-[3px]"
                              style={{
                                width: pending ? "0%" : `round(${bar.usedPercent}%, 1px)`,
                                backgroundColor: bar.spark ? "#0284C7" : color,
                              }}
                            />
                          </span>
                          <span className="w-7 shrink-0 text-right text-[11px] leading-4 font-normal tabular-nums text-sidebar-muted-foreground">
                            {pending ? (
                              <span className="block h-2 w-7 rounded-sm bg-sidebar-border" />
                            ) : (
                              `${Math.round(bar.usedPercent)}%`
                            )}
                          </span>
                        </span>
                      ))}
                      {status && displayedBars.length < 2 && (
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
              {environments.some((environment) => environment.isPending) ? (
                <span role="status" aria-label="Loading accounts" className="flex flex-col gap-6">
                  {[0, 1, 2].map((key) => (
                    <span key={key} aria-hidden className="flex flex-col gap-3">
                      <span className="h-4 w-36 rounded-sm bg-sidebar-border" />
                      <span className="ml-8 h-1 w-44 rounded-sm bg-sidebar-border" />
                      <span className="ml-8 h-1 w-44 rounded-sm bg-sidebar-border" />
                    </span>
                  ))}
                </span>
              ) : accounts.length > 0 ? (
                "No matching accounts"
              ) : (
                "No enabled accounts"
              )}
            </p>
          )}
        </SidebarGroup>
      </SidebarContent>
      {footer}
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
