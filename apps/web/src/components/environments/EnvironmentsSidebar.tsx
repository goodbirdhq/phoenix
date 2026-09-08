import { environmentConnectionKind } from "./environmentConnectionKind";
import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ListFilterIcon, MoreHorizontalIcon, PlusIcon, SearchIcon } from "lucide-react";
import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import { useClientSettings } from "../../hooks/useSettings";
import { useAtomCommand } from "../../state/use-atom-command";
import { environmentCatalog } from "../../connection/catalog";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuCheckboxItem } from "../ui/menu";
import { SidebarContent, useSidebar } from "../ui/sidebar";
import { SidebarChromeFooter } from "../sidebar/SidebarChrome";
import { EnvironmentIcon } from "./EnvironmentIcon";
import { cn } from "../../lib/utils";

export function EnvironmentsSidebar() {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const appearance = useClientSettings((s) => s.environmentAppearance);
  const route = useSearch({ strict: false });
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const retry = useAtomCommand(environmentCatalog.retryNow, "reconnect environment");
  const disconnect = useAtomCommand(environmentCatalog.disconnect, "disconnect environment");
  const remove = useAtomCommand(environmentCatalog.remove, "remove environment");
  const [removing, setRemoving] = useState<EnvironmentPresentation | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<string[]>([]);
  const [kinds, setKinds] = useState<string[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const selected = environments.some(
    (environment) => environment.environmentId === route.environment,
  )
    ? route.environment
    : primary;
  const providerOptions = new Map<string, string>(
    environments.flatMap((env) =>
      (env.serverConfig?.providers ?? []).map(
        (provider) =>
          [
            `${provider.driver}:${provider.instanceId}`,
            provider.displayName ?? provider.driver,
          ] as const,
      ),
    ),
  );
  const toggle = (values: string[], value: string) =>
    values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
  const ordered = environments.toSorted((a, b) =>
    a.environmentId === primary
      ? -1
      : b.environmentId === primary
        ? 1
        : a.environmentId.localeCompare(b.environmentId),
  );
  const visible = ordered.filter((env) => {
    const label = appearance[env.environmentId]?.alias || env.label;
    return (
      `${label} ${env.label} ${env.displayUrl ?? ""}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()) &&
      (!statuses.length ||
        statuses.includes(
          env.connection.phase === "available" ? "offline" : env.connection.phase,
        )) &&
      (!kinds.length || kinds.includes(environmentConnectionKind(env))) &&
      (!providers.length ||
        env.serverConfig?.providers.some((p) => providers.includes(`${p.driver}:${p.instanceId}`)))
    );
  });
  const filterCount =
    Number(statuses.length > 0) + Number(kinds.length > 0) + Number(providers.length > 0);
  return (
    <>
      <div className="flex h-[52px] shrink-0 items-center gap-1 px-4">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
          <SearchIcon className="size-4 shrink-0" />
          <input
            aria-label="Search environments"
            placeholder="Search environments"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={`Filter environments${filterCount ? ` (${filterCount})` : ""}`}
              />
            }
          >
            <ListFilterIcon className="size-4" />
            {filterCount || null}
          </MenuTrigger>
          <MenuPopup>
            {[
              {
                title: "Status",
                values: ["connected", "connecting", "reconnecting", "error", "offline"],
                selected: statuses,
                set: setStatuses,
              },
              {
                title: "Connection type",
                values: ["Local", "SSH", "Remote link", "T3 Connect"],
                selected: kinds,
                set: setKinds,
              },
              {
                title: "Provider accounts",
                values: [...providerOptions.keys()],
                selected: providers,
                set: setProviders,
              },
            ].map((group) => (
              <div key={group.title}>
                <div className="px-2 py-2 text-xs font-medium text-muted-foreground">
                  {group.title}
                </div>
                {group.values.map((v) => (
                  <MenuCheckboxItem
                    key={v}
                    checked={group.selected.includes(v)}
                    onCheckedChange={() => group.set(toggle(group.selected, v))}
                  >
                    {group.title === "Provider accounts"
                      ? providerOptions.get(v)
                      : v === "error"
                        ? "Connection failed"
                        : v.charAt(0).toUpperCase() + v.slice(1)}
                  </MenuCheckboxItem>
                ))}
              </div>
            ))}
            <MenuItem
              onClick={() => {
                setStatuses([]);
                setKinds([]);
                setProviders([]);
              }}
            >
              Clear filters
            </MenuItem>
          </MenuPopup>
        </Menu>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 border-sky-500/30 bg-sky-500/10 text-sky-600 hover:bg-sky-500/15"
          aria-label="Add environment"
          onClick={() => void navigate({ to: "/environments", search: { ...route, add: true } })}
        >
          <PlusIcon className="size-4" />
        </Button>
      </div>
      <SidebarContent>
        <div className="flex items-center justify-between px-5 py-3 text-xs font-medium text-muted-foreground">
          <span>Environments</span>
          <span>{visible.length}</span>
        </div>
        <div className="space-y-1 px-2.5">
          {visible.map((env) => (
            <div
              key={env.environmentId}
              className={cn(
                "group relative rounded-lg",
                env.environmentId === selected && "bg-background",
              )}
            >
              <button
                className="flex min-h-[88px] w-full flex-col gap-1 rounded-lg px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  void navigate({
                    to: "/environments",
                    search: { ...route, environment: env.environmentId, edit: undefined },
                  });
                  if (isMobile) setOpenMobile(false);
                }}
                aria-current={env.environmentId === selected ? "page" : undefined}
              >
                <span className="flex w-full items-center gap-2 pr-6">
                  <EnvironmentIcon
                    environmentId={env.environmentId}
                    className="size-[18px] shrink-0 text-muted-foreground"
                  />
                  <span className="environment-inter truncate text-sm font-medium">
                    {appearance[env.environmentId]?.alias || env.label}
                  </span>
                </span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      env.connection.phase === "connected"
                        ? "bg-emerald-500"
                        : env.connection.phase === "error"
                          ? "bg-red-500"
                          : "bg-zinc-400",
                    )}
                  />
                  {env.connection.phase === "available"
                    ? "Offline"
                    : connectionStatusTitle(env.connection)}
                  {env.environmentId === primary ? " · Primary" : ""}
                </span>
                <span className="w-full truncate text-xs text-muted-foreground">
                  {environmentConnectionKind(env)} ·{" "}
                  {environmentConnectionKind(env) === "Local"
                    ? "This machine"
                    : (env.displayUrl ?? env.label)}
                </span>
              </button>
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Actions for ${appearance[env.environmentId]?.alias || env.label}`}
                      className="absolute top-2.5 right-2 size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"
                    />
                  }
                >
                  <MoreHorizontalIcon className="size-4" />
                </MenuTrigger>
                <MenuPopup>
                  <MenuItem
                    onClick={() =>
                      void navigate({
                        to: "/environments",
                        search: { ...route, environment: env.environmentId, edit: true },
                      })
                    }
                  >
                    Edit environment
                  </MenuItem>
                  {env.displayUrl && (
                    <MenuItem
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(env.displayUrl!);
                          setMessage("Endpoint copied.");
                        } catch {
                          setMessage(
                            "Could not copy the endpoint. Open Connections to copy it manually.",
                          );
                        }
                      }}
                    >
                      Copy endpoint
                    </MenuItem>
                  )}
                  {env.environmentId !== primary &&
                    !env.relayManaged &&
                    !isDesktopLocalConnectionTarget(env.entry.target) && (
                      <>
                        {env.connection.phase === "connected" && (
                          <MenuItem
                            disabled={busy}
                            onClick={async () => {
                              setBusy(true);
                              try {
                                await disconnect(env.environmentId);
                              } finally {
                                setBusy(false);
                              }
                            }}
                          >
                            Disconnect
                          </MenuItem>
                        )}
                        <MenuItem disabled={busy} onClick={() => setRemoving(env)}>
                          Remove environment
                        </MenuItem>
                      </>
                    )}
                  {env.connection.phase !== "connected" && (
                    <MenuItem onClick={() => void retry(env.environmentId)}>
                      Retry connection
                    </MenuItem>
                  )}
                </MenuPopup>
              </Menu>
            </div>
          ))}
          {!visible.length && (
            <p className="px-3 py-6 text-sm text-muted-foreground">
              No environments match your search and filters.
            </p>
          )}
          {selected && !visible.some((e) => e.environmentId === selected) && (
            <Button
              variant="ghost"
              onClick={() => {
                setSearch("");
                setStatuses([]);
                setKinds([]);
                setProviders([]);
              }}
            >
              Show selected environment in list
            </Button>
          )}
        </div>
      </SidebarContent>
      {message && (
        <p role="status" className="px-5 py-2 text-xs text-muted-foreground">
          {message}
        </p>
      )}
      <SidebarChromeFooter />
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoving(null);
        }}
      >
        <DialogPopup className="usage-surface environment-surface rounded-[14px] sm:max-w-[620px]">
          <DialogHeader>
            <DialogTitle>
              Remove {removing && (appearance[removing.environmentId]?.alias || removing.label)}?
            </DialogTitle>
            <DialogDescription>
              This forgets the saved connection on this client. Projects, files and threads on the
              environment are retained. Pair again to reconnect.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (!removing || busy) return;
                setBusy(true);
                try {
                  const result = await remove(removing.environmentId);
                  if (result._tag === "Success") {
                    setRemoving(null);
                    if (route.environment === removing.environmentId)
                      void navigate({ to: "/environments", search: { tab: "overview" } });
                  }
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Removing…" : "Remove environment"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
