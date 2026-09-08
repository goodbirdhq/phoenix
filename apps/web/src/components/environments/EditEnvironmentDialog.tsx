import { useState } from "react";
import * as Option from "effect/Option";
import { SettingsIcon, ShieldCheckIcon, SlidersHorizontalIcon } from "lucide-react";
import type { EnvironmentPresentation } from "../../state/environments";
import {
  useClientSettings,
  useUpdateClientSettings,
  useEnvironmentSettings,
} from "../../hooks/useSettings";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { environmentCatalog } from "../../connection/catalog";
import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogPanel,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs";
import { ENVIRONMENT_ICONS, type EnvironmentIconKind } from "./EnvironmentIcon";
import { EnvironmentAccess } from "./EnvironmentAccess";
import { EnvironmentConnections } from "./EnvironmentConnections";

export function EditEnvironmentDialog({
  environment,
  onClose,
}: {
  environment: EnvironmentPresentation;
  onClose: () => void;
}) {
  const appearance = useClientSettings((s) => s.environmentAppearance);
  const update = useUpdateClientSettings();
  const settings = useEnvironmentSettings(environment.environmentId);
  const session = useEnvironmentSessionState(environment.environmentId);
  const canConfigure =
    environment.connection.phase === "connected" &&
    (session.data?.scopes?.includes("orchestration:operate") ?? false);
  const saveSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "save environment settings",
  );
  const saveAutoConnect = useAtomCommand(
    environmentCatalog.setAutoConnect,
    "save reconnect preference",
  );
  const saved = appearance[environment.environmentId];
  const savedAutoConnect = Option.isSome(environment.entry.profile)
    ? environment.entry.profile.value.autoConnect !== false
    : true;
  const canSetAutoConnect =
    Option.isSome(environment.entry.profile) &&
    !isDesktopLocalConnectionTarget(environment.entry.target);
  const [aliasDraft, setAlias] = useState<string | null>(null);
  const alias = aliasDraft ?? (saved?.alias || environment.label);
  const [iconDraft, setIcon] = useState<EnvironmentIconKind | null>(null);
  const icon = iconDraft ?? saved?.icon ?? "desktop";
  const [directoryDraft, setDirectory] = useState<string | null>(null);
  const directory = directoryDraft ?? settings.addProjectBaseDirectory;
  const [autoConnectDraft, setAutoConnect] = useState<boolean | null>(null);
  const autoConnect = autoConnectDraft ?? savedAutoConnect;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const PreviewIcon = ENVIRONMENT_ICONS[icon];
  const dirty =
    alias !== (saved?.alias || environment.label) ||
    icon !== (saved?.icon ?? "desktop") ||
    directory !== settings.addProjectBaseDirectory ||
    autoConnect !== savedAutoConnect;
  const requestClose = () => {
    if (!busy) {
      if (dirty) setDiscarding(true);
      else onClose();
    }
  };
  const save = async () => {
    if (busy || !alias.trim()) return;
    if (directory.trim() !== settings.addProjectBaseDirectory && !canConfigure) {
      setError(
        "Reconnect with Operate tasks permission to save your working-directory change. Your draft is still here.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (directory.trim() !== settings.addProjectBaseDirectory && canConfigure) {
        const result = await saveSettings({
          environmentId: environment.environmentId,
          input: { patch: { addProjectBaseDirectory: directory.trim() } },
        });
        if (result._tag === "Failure") {
          setError("Could not save the working directory. Your draft is still here.");
          return;
        }
      }
      if (autoConnect !== savedAutoConnect && canSetAutoConnect) {
        const result = await saveAutoConnect({
          environmentId: environment.environmentId,
          autoConnect,
        });
        if (result._tag === "Failure") {
          setError(
            "Could not save the reconnect preference. Any working-directory change was saved; retry to finish saving.",
          );
          return;
        }
      }
      update({
        environmentAppearance: {
          ...appearance,
          [environment.environmentId]: { alias: alias.trim(), icon },
        },
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
      >
        <DialogPopup className="usage-surface environment-surface flex max-h-[90dvh] flex-col rounded-[14px] sm:max-w-[620px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PreviewIcon className="size-5" strokeWidth={1.5} />
              Edit {alias || environment.label}
            </DialogTitle>
            <DialogDescription>
              Manage this environment without leaving Environments.
            </DialogDescription>
          </DialogHeader>
          <Tabs defaultValue="general" className="flex min-h-0 flex-1 flex-col">
            <TabsList className="mx-6 shrink-0 justify-start gap-6">
              <TabsTrigger value="general">
                <SettingsIcon className="size-4" />
                General
              </TabsTrigger>
              <TabsTrigger value="access">
                <ShieldCheckIcon className="size-4" />
                Access
              </TabsTrigger>
              <TabsTrigger value="advanced">
                <SlidersHorizontalIcon className="size-4" />
                Advanced
              </TabsTrigger>
            </TabsList>
            <DialogPanel className="min-h-0 overflow-y-auto">
              <TabsContent value="general" className="space-y-6">
                <label className="block space-y-2 text-sm">
                  <span>Environment name</span>
                  <Input required value={alias} onChange={(e) => setAlias(e.target.value)} />
                  <span className="block text-xs text-muted-foreground">
                    Display name on this client.
                  </span>
                </label>
                <div className="space-y-1 text-sm">
                  <span>Location</span>
                  <p className="text-muted-foreground">
                    {environment.entry.target._tag === "PrimaryConnectionTarget"
                      ? "This machine"
                      : "Remote machine"}
                  </p>
                  <p className="text-xs text-muted-foreground">Determined by its connection.</p>
                </div>
                <fieldset>
                  <legend className="mb-2 text-sm">Environment icon</legend>
                  <div className="flex gap-3">
                    {Object.entries(ENVIRONMENT_ICONS).map(([kind, Icon]) => (
                      <label
                        key={kind}
                        className="flex flex-1 cursor-pointer flex-col items-center gap-2 rounded-lg border p-3 has-[:checked]:border-foreground has-[:checked]:bg-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
                      >
                        <input
                          type="radio"
                          name="environment-icon"
                          value={kind}
                          checked={icon === kind}
                          onChange={() => setIcon(kind as EnvironmentIconKind)}
                          className="sr-only"
                        />
                        <Icon className="size-5" strokeWidth={1.5} />
                        <span className="text-sm capitalize">{kind}</span>
                      </label>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Shown in the sidebar and page title.
                  </p>
                </fieldset>
                <label className="block space-y-2 text-sm">
                  <span>Working directory</span>
                  <Input
                    value={directory}
                    disabled={!canConfigure}
                    onChange={(e) => setDirectory(e.target.value)}
                    placeholder="~/"
                  />
                  <span className="block text-xs text-muted-foreground">
                    Starting folder when adding projects on this environment. Requires Operate tasks
                    permission.
                  </span>
                </label>
                {canSetAutoConnect && (
                  <label className="flex items-center justify-between gap-4">
                    <span>
                      <span className="block text-sm">Reconnect automatically</span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        Restore this environment when Phoenix starts.
                      </span>
                    </span>
                    <Switch checked={autoConnect} onCheckedChange={setAutoConnect} />
                  </label>
                )}
              </TabsContent>
              <TabsContent value="access">
                <p className="mb-5 text-xs text-muted-foreground">
                  Pairing and revocation apply immediately, independently of Save changes.
                </p>
                {environment.connection.phase === "connected" ? (
                  <EnvironmentAccess environmentId={environment.environmentId} />
                ) : (
                  <p className="text-sm text-muted-foreground">Reconnect to manage access.</p>
                )}
              </TabsContent>
              <TabsContent value="advanced">
                <EnvironmentConnections environment={environment} detailsOnly />
              </TabsContent>
              {error && (
                <p role="alert" className="mt-4 text-sm text-destructive">
                  {error}
                </p>
              )}
            </DialogPanel>
          </Tabs>
          <DialogFooter className="shrink-0 border-t">
            <span className="mr-auto text-xs text-muted-foreground">
              Changes apply across all tabs.
            </span>
            <Button variant="outline" disabled={busy} onClick={requestClose}>
              Cancel
            </Button>
            <Button disabled={busy || !alias.trim()} onClick={() => void save()}>
              {busy ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog open={discarding} onOpenChange={setDiscarding}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              Your name, icon, directory and reconnect draft will be discarded. Completed access
              actions remain applied.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscarding(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={onClose}>
              Discard changes
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
