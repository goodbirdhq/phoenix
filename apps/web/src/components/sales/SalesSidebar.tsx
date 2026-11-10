import { buildSalesHome } from "@t3tools/client-runtime/sales/home";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as Option from "effect/Option";
import {
  ChevronsUpDownIcon,
  HouseIcon,
  type LucideIcon,
  MessagesSquareIcon,
  SendIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { SalesArea } from "../../routes/sales";

import { useSalesState, useSalesTarget } from "../../state/sales";
import { SidebarChromeFooter } from "../sidebar/SidebarChrome";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import {
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";

/**
 * The Sales areas with a screen, in sidebar order. A new area shows by adding its line here
 * (and its key to `SalesArea`); groups with no entry are not shown. Counts come from the Home
 * summary where it has an area with the same key.
 */
const SALES_NAV: ReadonlyArray<{
  readonly area: SalesArea;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly group: "Work" | "Strategy" | "Records";
}> = [
  { area: "outreach", label: "Outreach", icon: SendIcon, group: "Work" },
  { area: "conversations", label: "Conversations", icon: MessagesSquareIcon, group: "Work" },
];
const SALES_NAV_GROUPS = ["Work", "Strategy", "Records"] as const;

export function SalesSidebar() {
  const { environment: requested, area } = useSearch({ from: "/sales" });
  const { environments, target } = useSalesTarget(requested);
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <>
      <div className="flex h-[52px] shrink-0 items-center gap-2 px-4">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">Sales</span>
        {target && environments.length > 1 ? (
          <Menu>
            <MenuTrigger
              render={
                <Button variant="ghost" size="xs" aria-label="Choose the Sales environment" />
              }
            >
              <span className="max-w-32 truncate">{target.label}</span>
              <ChevronsUpDownIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              {environments.map((environment) => (
                <MenuItem
                  key={environment.environmentId}
                  onClick={() =>
                    void navigate({
                      to: "/sales",
                      search: { environment: environment.environmentId },
                    })
                  }
                >
                  {environment.label}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
      <SidebarContent>
        {target ? (
          <SalesSidebarNav
            environmentId={target.environmentId}
            requested={requested}
            area={area}
            onNavigate={closeMobile}
          />
        ) : null}
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

function SalesSidebarNav({
  environmentId,
  requested,
  area: currentArea,
  onNavigate,
}: {
  readonly environmentId: EnvironmentId;
  readonly requested: string | undefined;
  readonly area: SalesArea | undefined;
  readonly onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const state = useSalesState(environmentId);
  const summary = Option.getOrNull(state.snapshot)?.summary ?? null;
  const counts: ReadonlyMap<string, number> = new Map(
    summary ? buildSalesHome(summary).areas.map((area) => [area.key, area.count]) : [],
  );

  return (
    <nav aria-label="Sales" className="flex min-h-full flex-col px-2.5 pb-2">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={currentArea === undefined}
            onClick={() => {
              onNavigate();
              void navigate({ to: "/sales", search: requested ? { environment: requested } : {} });
            }}
          >
            <HouseIcon />
            <span>Home</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>

      {SALES_NAV_GROUPS.map((group) => {
        const entries = SALES_NAV.filter((entry) => entry.group === group);
        if (entries.length === 0) return null;
        return (
          <SalesSidebarGroup key={group} label={group}>
            {entries.map(({ area, label, icon: Icon }) => {
              const count = counts.get(area) ?? 0;
              return (
                <SidebarMenuItem key={area}>
                  <SidebarMenuButton
                    isActive={currentArea === area}
                    aria-label={count > 0 ? `${label}, ${count}` : label}
                    onClick={() => {
                      onNavigate();
                      void navigate({
                        to: "/sales",
                        search: { ...(requested ? { environment: requested } : {}), area },
                      });
                    }}
                  >
                    <Icon />
                    <span className="flex-1">{label}</span>
                    {count > 0 ? <span className="text-xs tabular-nums">{count}</span> : null}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SalesSidebarGroup>
        );
      })}

      <div className="mt-auto pt-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => {
                onNavigate();
                void navigate({ to: "/settings/integrations", hash: "sales-engine" });
              }}
            >
              <SettingsIcon />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </div>
    </nav>
  );
}

function SalesSidebarGroup({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={label} className="pt-4">
      <h2 className="px-2 pb-1 text-xs text-muted-foreground">{label}</h2>
      <SidebarMenu>{children}</SidebarMenu>
    </section>
  );
}
