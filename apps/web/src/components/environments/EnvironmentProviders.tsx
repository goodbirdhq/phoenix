import { Link } from "@tanstack/react-router";
import { resolveAppModelSelectionState } from "../../modelSelection";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import { PlusIcon, RefreshCwIcon, MoreHorizontalIcon } from "lucide-react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentSessionState } from "../../state/session";
import { useEnvironment } from "../../state/environments";
import { DRIVER_OPTION_BY_VALUE } from "../settings/providerDriverMeta";
import { AddProviderInstanceDialog } from "../settings/AddProviderInstanceDialog";
import { UsageProviderDialog } from "../usage/UsageProviderDialog";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  buildProviderInstanceUpdatePatch,
  resolveProviderInstanceSettings,
} from "../settings/SettingsPanels.logic";
import {
  collectProviderUpdateCandidates,
  canOneClickUpdateProviderCandidate,
  isProviderUpdateActive,
} from "../ProviderUpdateLaunchNotification.logic";

export function EnvironmentProviders({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const enabledProviders = providers?.filter((provider) => provider.enabled);
  const environment = useEnvironment(environmentId);
  const session = useEnvironmentSessionState(environmentId);
  const canEdit = session.data?.scopes?.includes("orchestration:operate") ?? false;
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, "refresh providers");
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "update provider instance",
  );
  const updateProvider = useAtomCommand(
    serverEnvironment.updateProvider,
    "update provider runtime",
  );
  const candidates = collectProviderUpdateCandidates(providers ?? []);
  const [pendingDriver, setPendingDriver] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ServerProvider | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggleEnabled = async (provider: ServerProvider) => {
    const saved = resolveProviderInstanceSettings(settings, provider.instanceId, provider.driver);
    if (!saved) return;
    setMutationBusy(true);
    setError(null);
    try {
      const result = await updateSettings({
        environmentId,
        input: {
          patch: buildProviderInstanceUpdatePatch({
            settings,
            instanceId: provider.instanceId,
            driver: provider.driver,
            isDefault: provider.instanceId === defaultInstanceIdForDriver(provider.driver),
            ...(provider.enabled &&
            resolveAppModelSelectionState(settings, providers ?? []).instanceId ===
              provider.instanceId
              ? {
                  textGenerationModelSelection:
                    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                }
              : {}),
            instance: { ...saved, enabled: !provider.enabled },
          }),
        },
      });
      if (result._tag === "Failure") setError("Could not change provider availability. Try again.");
    } finally {
      setMutationBusy(false);
    }
  };
  const deleteInstance = async () => {
    if (!deleting) return;
    setMutationBusy(true);
    setError(null);
    try {
      const providerInstances = Object.fromEntries(
        Object.entries(settings.providerInstances).filter(([id]) => id !== deleting.instanceId),
      );
      const result = await updateSettings({
        environmentId,
        input: {
          patch: {
            providerInstances,
            ...(resolveAppModelSelectionState(settings, providers ?? []).instanceId ===
            deleting.instanceId
              ? {
                  textGenerationModelSelection:
                    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                }
              : {}),
          },
        },
      });
      if (result._tag === "Failure") setError("Could not delete this provider. Try again.");
      else setDeleting(null);
    } finally {
      setMutationBusy(false);
    }
  };
  const [editing, setEditing] = useState<ServerProvider | null>(null);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base leading-[22px] font-semibold">Providers on {label}</h2>
          <p className="mt-1 text-xs leading-[18px] text-muted-foreground">
            Provider instances, credentials and configuration on this machine.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            data-environment-control
            variant="outline"
            size="sm"
            disabled={refreshing || !canEdit}
            onClick={async () => {
              setRefreshing(true);
              try {
                await refresh({ environmentId, input: {} });
              } finally {
                setRefreshing(false);
              }
            }}
          >
            <RefreshCwIcon className="size-3.5" />
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
          <Button
            data-environment-control
            size="sm"
            disabled={!canEdit}
            onClick={() => setAdding(true)}
          >
            <PlusIcon className="size-3.5" />
            Add provider
          </Button>
        </div>
      </div>
      {!canEdit && (
        <p className="text-sm text-muted-foreground">
          Operate tasks permission is required to configure providers.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Table className="environment-table">
        <TableHeader>
          <TableRow>
            <TableHead>Provider account</TableHead>
            <TableHead className="w-[140px]">Installed version</TableHead>
            <TableHead className="w-[160px]">Status</TableHead>
            <TableHead className="w-[180px]">Authentication</TableHead>
            <TableHead className="w-[272px]">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {enabledProviders?.map((provider) => {
            const definition = DRIVER_OPTION_BY_VALUE[provider.driver];
            const Mark = definition?.icon;
            const candidate = candidates.find((c) => c.driver === provider.driver);
            const updating =
              pendingDriver === provider.driver ||
              (providers ?? []).some(
                (p) => p.driver === provider.driver && isProviderUpdateActive(p),
              );
            return (
              <TableRow key={provider.instanceId}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    {Mark && <Mark className="size-5 shrink-0" />}
                    <div>
                      <p className="text-[13px] leading-[18px] font-medium">
                        {provider.displayName ?? definition?.label ?? provider.driver}
                      </p>
                      <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
                        {provider.instanceId === defaultInstanceIdForDriver(provider.driver)
                          ? "Default instance"
                          : "Named instance"}
                      </p>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  {provider.version ?? (provider.installed ? "Unknown" : "Not installed")}
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-3 capitalize">
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${provider.status === "ready" ? "bg-emerald-700" : provider.status === "disabled" ? "bg-zinc-500" : "bg-amber-700"}`}
                    />
                    {provider.status}
                  </span>
                  {provider.message && provider.status !== "disabled" && (
                    <p className="mt-1 max-w-52 text-xs text-muted-foreground">
                      {provider.message}
                    </p>
                  )}
                </TableCell>
                <TableCell>
                  <span className="capitalize">{provider.auth.status}</span>
                  {provider.auth.email && (
                    <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
                      {provider.auth.email}
                    </p>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center gap-5">
                    {candidate && (
                      <Button
                        data-environment-control
                        data-environment-action
                        size="sm"
                        variant="link"
                        disabled={
                          !canEdit ||
                          updating ||
                          !canOneClickUpdateProviderCandidate(candidate, providers ?? [])
                        }
                        onClick={async () => {
                          setPendingDriver(provider.driver);
                          try {
                            await updateProvider({
                              environmentId,
                              input: {
                                provider: candidate.driver,
                                instanceId: candidate.instanceId,
                              },
                            });
                          } finally {
                            setPendingDriver(null);
                          }
                        }}
                      >
                        {updating ? "Updating…" : "Update"}
                      </Button>
                    )}
                    {!candidate && (
                      <Button
                        data-environment-control
                        data-environment-action
                        size="sm"
                        variant="link"
                        disabled={!canEdit || mutationBusy}
                        onClick={() => setEditing(provider)}
                      >
                        Configure →
                      </Button>
                    )}
                    <span className="flex-1" />
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            aria-label={`Actions for ${provider.displayName ?? provider.driver}`}
                          />
                        }
                      >
                        <MoreHorizontalIcon className="size-4" />
                      </MenuTrigger>
                      <MenuPopup>
                        <MenuItem disabled={!canEdit} onClick={() => setEditing(provider)}>
                          Configure
                        </MenuItem>
                        <MenuItem
                          disabled={!canEdit || mutationBusy}
                          onClick={() => void toggleEnabled(provider)}
                        >
                          {provider.enabled ? "Disable" : "Enable"}
                        </MenuItem>
                        {provider.instanceId !== defaultInstanceIdForDriver(provider.driver) && (
                          <MenuItem
                            disabled={!canEdit || mutationBusy}
                            onClick={() => setDeleting(provider)}
                          >
                            Delete provider
                          </MenuItem>
                        )}
                      </MenuPopup>
                    </Menu>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
          {!enabledProviders?.length && (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">
                {providers === null
                  ? "Loading providers…"
                  : "No enabled providers. Add a provider to get started."}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <section className="space-y-6 pt-3">
        <div>
          <h2 className="text-base font-semibold">Provider configuration</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Select an instance above to manage its settings.
          </p>
        </div>
        <div className="grid gap-x-8 gap-y-6 border-y py-5 sm:grid-cols-3">
          <div>
            <h3 className="text-sm font-medium">Instances &amp; authentication</h3>
            <p className="mt-1 text-xs leading-[18px] text-muted-foreground">
              Add accounts, rename instances, enable or disable, configure credentials and remove
              named instances.
            </p>
          </div>
          <div>
            <h3 className="text-sm font-medium">Runtime &amp; models</h3>
            <p className="mt-1 text-xs leading-[18px] text-muted-foreground">
              Binary path, environment variables, provider settings and model availability.
            </p>
          </div>
          <div>
            <h3 className="text-sm font-medium">Health &amp; updates</h3>
            <p className="mt-1 text-xs leading-[18px] text-muted-foreground">
              Refresh health, review update details and use supported update methods.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium">Account usage</h3>
            <p className="mt-1 text-xs leading-[18px] text-muted-foreground">
              Inspect limits and usage in the Usage destination.
            </p>
          </div>
          <Button data-environment-control variant="outline" render={<Link to="/usage" />}>
            View usage
          </Button>
        </div>
      </section>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setEditing(null);
        }}
      >
        {editing && (
          <UsageProviderDialog
            key={editing.instanceId}
            environmentId={environmentId}
            instanceId={editing.instanceId}
            driver={editing.driver}
            onClose={() => setEditing(null)}
            onSavingChange={setSaving}
          />
        )}
      </Dialog>
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !mutationBusy) setDeleting(null);
        }}
      >
        <DialogPopup className="rounded-[14px] sm:max-w-[620px]">
          <DialogHeader>
            <DialogTitle>Delete provider?</DialogTitle>
            <DialogDescription>
              Remove {deleting?.displayName ?? deleting?.driver} from this environment. Existing
              thread history is retained.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="px-6 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={mutationBusy} onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={mutationBusy}
              onClick={() => void deleteInstance()}
            >
              {mutationBusy ? "Deleting…" : "Delete provider"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      {adding && (
        <AddProviderInstanceDialog
          open
          environmentId={environmentId}
          environmentLabel={environment?.label ?? "Environment"}
          onOpenChange={setAdding}
        />
      )}
    </section>
  );
}
