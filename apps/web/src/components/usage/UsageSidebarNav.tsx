import { lazy, Suspense, useMemo, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ChartNoAxesCombinedIcon, SearchIcon, ListFilterIcon, PlusIcon } from "lucide-react";
import { buildUsageAccounts, usageAccountMemberKey } from "@t3tools/client-runtime/usage/accounts";
import { subscriptionAvailabilitySources } from "@t3tools/client-runtime/usage/usage-warning";
import { deriveSubscriptionLimits } from "@t3tools/client-runtime/usage/subscription-availability";
import { EnvironmentId } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuCheckboxItem } from "../ui/menu";
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

const AddProviderInstanceDialog = lazy(() =>
  import("../settings/AddProviderInstanceDialog").then((module) => ({
    default: module.AddProviderInstanceDialog,
  })),
);

export function UsageSidebarNav() {
  const environments = useProviderAvailability();
  const accounts = useMemo(() => buildUsageAccounts(environments, []), [environments]);
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
            <PlusIcon className="size-4.5" />
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
              <PlusIcon className="size-4.5" />
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
        <SidebarGroup className="px-4 pt-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton isActive={!selected} onClick={() => select()}>
                <ChartNoAxesCombinedIcon />
                All accounts
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <SidebarGroupLabel className="mt-5">Accounts</SidebarGroupLabel>
          <SidebarMenu>
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
