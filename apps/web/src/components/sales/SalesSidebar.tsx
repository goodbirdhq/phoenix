import { buildSalesHome, SALES_WORK_AREAS } from "@t3tools/client-runtime/sales/home";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as Option from "effect/Option";
import {
  BuildingIcon,
  ChevronsUpDownIcon,
  HouseIcon,
  MegaphoneIcon,
  MessagesSquareIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  SquareCheckBigIcon,
  ZapIcon,
} from "lucide-react";
import type { ReactNode } from "react";

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

const AREA_ICONS = {
  sourcing: SearchIcon,
  outreach: SendIcon,
  autopilot: ZapIcon,
  todo: SquareCheckBigIcon,
  conversations: MessagesSquareIcon,
} as const;

export function SalesSidebar() {
  const { environment: requested } = useSearch({ from: "/sales" });
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
          <SalesSidebarNav environmentId={target.environmentId} onNavigate={closeMobile} />
        ) : null}
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

function SalesSidebarNav({
  environmentId,
  onNavigate,
}: {
  readonly environmentId: EnvironmentId;
  readonly onNavigate: () => void;
}) {
  const navigate = useNavigate();
  const state = useSalesState(environmentId);
  const summary = Option.getOrNull(state.snapshot)?.summary ?? null;
  const counts = new Map(
    summary ? buildSalesHome(summary).areas.map((area) => [area.key, area.count]) : [],
  );

  return (
    <nav aria-label="Sales" className="flex min-h-full flex-col px-2.5 pb-2">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton isActive onClick={onNavigate}>
            <HouseIcon />
            <span>Home</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>

      <SalesSidebarGroup label="Work">
        {SALES_WORK_AREAS.map((area) => {
          const Icon = AREA_ICONS[area.key];
          const count = counts.get(area.key) ?? null;
          return (
            <SalesPlaceholderItem
              key={area.key}
              icon={<Icon />}
              label={area.label}
              count={count !== null && count > 0 ? count : null}
            />
          );
        })}
      </SalesSidebarGroup>
      <SalesSidebarGroup label="Strategy">
        <SalesPlaceholderItem icon={<MegaphoneIcon />} label="Campaigns" count={null} />
      </SalesSidebarGroup>
      <SalesSidebarGroup label="Records">
        <SalesPlaceholderItem icon={<BuildingIcon />} label="Accounts" count={null} />
      </SalesSidebarGroup>

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

/** An area that has no screen yet: listed so the shape of Sales is visible, not clickable. */
function SalesPlaceholderItem({
  icon,
  label,
  count,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly count: number | null;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton disabled aria-label={count === null ? label : `${label}, ${count}`}>
        {icon}
        <span className="flex-1">{label}</span>
        {count !== null ? <span className="text-xs tabular-nums">{count}</span> : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
