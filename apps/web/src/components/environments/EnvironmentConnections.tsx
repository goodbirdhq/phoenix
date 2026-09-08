import { useAtomValue } from "@effect/atom-react";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { ServerUpdateAction, ServerUpdateProgress } from "../ServerUpdateAction";
import {
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "../../versionSkew";
import { EnvironmentIcon } from "./EnvironmentIcon";
import { useClientSettings } from "../../hooks/useSettings";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { EnvironmentPresentation } from "../../state/environments";
import { usePrimaryEnvironmentId, useEnvironments } from "../../state/environments";
import { environmentCatalog } from "../../connection/catalog";
import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectionsSettings, EnvironmentEditorHandoffRow } from "../settings/ConnectionsSettings";
import { environmentConnectionKind } from "./environmentConnectionKind";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { CopyIcon, CableIcon } from "lucide-react";

export function EnvironmentConnections({
  environment,
  detailsOnly = false,
}: {
  environment: EnvironmentPresentation;
  detailsOnly?: boolean;
}) {
  const primary = usePrimaryEnvironmentId();
  const updateState = useAtomValue(serverEnvironment.updateStateAtom(environment.environmentId));
  const versionMismatch = resolveServerConfigVersionMismatch(environment.serverConfig);
  const session = useEnvironmentSessionState(environment.environmentId);
  const canUpdate = session.data?.scopes?.includes("orchestration:operate") ?? false;
  const navigate = useNavigate();
  const retry = useAtomCommand(environmentCatalog.retryNow, "reconnect environment");
  const disconnect = useAtomCommand(environmentCatalog.disconnect, "disconnect environment");
  const remove = useAtomCommand(environmentCatalog.remove, "remove environment");
  const [removing, setRemoving] = useState<EnvironmentPresentation | null>(null);
  const { environments } = useEnvironments();
  const appearance = useClientSettings((settings) => settings.environmentAppearance);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const managed =
    environment.environmentId === primary ||
    isDesktopLocalConnectionTarget(environment.entry.target) ||
    environment.relayManaged;
  const connected = environment.connection.phase === "connected";
  const act = async (kind: "disconnect" | "retry" | "remove") => {
    setBusy(true);
    setMessage("");
    try {
      const result = await (
        kind === "disconnect" ? disconnect : kind === "remove" ? remove : retry
      )(kind === "remove" && removing ? removing.environmentId : environment.environmentId);
      if (result._tag === "Failure")
        setMessage("Could not complete the action. Check the connection and try again.");
      else {
        setRemoving(null);
        if (kind === "remove" && removing?.environmentId === environment.environmentId)
          void navigate({ to: "/environments", search: { tab: "overview" } });
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-8">
      {(detailsOnly || environment.environmentId !== primary) && (
        <section className="space-y-5">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <CableIcon className="size-4" />
              Connection details
            </h2>
            <p className="mt-1.5 text-[13px] text-muted-foreground">
              How this client reaches {environment.label}.
            </p>
          </div>
          <dl className="divide-y divide-border border-y text-sm">
            <div className="flex justify-between gap-4 py-5">
              <dt>Connection type</dt>
              <dd className="text-muted-foreground">{environmentConnectionKind(environment)}</dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4 py-5">
              <dt>Endpoint</dt>
              <dd className="flex min-w-0 items-center gap-2">
                <span className="truncate text-muted-foreground">
                  {environment.displayUrl ?? "Managed connection"}
                </span>
                {environment.displayUrl && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Copy endpoint"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(environment.displayUrl!);
                        setMessage("Endpoint copied.");
                      } catch {
                        setMessage("Could not copy. Select the endpoint and copy it manually.");
                      }
                    }}
                  >
                    <CopyIcon className="size-4" />
                  </Button>
                )}
              </dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4 py-5">
              <dt>Status</dt>
              <dd className="flex items-center gap-3">
                <span className="capitalize text-muted-foreground">
                  {environment.connection.phase === "available"
                    ? "Offline"
                    : environment.connection.phase}
                </span>
                {!managed && (
                  <>
                    <Button
                      data-environment-control
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void act(connected ? "disconnect" : "retry")}
                    >
                      {busy ? "Working…" : connected ? "Disconnect" : "Reconnect"}
                    </Button>
                    <Button
                      data-environment-control
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setRemoving(environment)}
                    >
                      Remove
                    </Button>
                  </>
                )}
              </dd>
            </div>
            {environment.connection.traceId && (
              <div className="flex justify-between gap-4 py-5">
                <dt>Trace ID</dt>
                <dd className="select-all font-mono text-xs text-muted-foreground">
                  {environment.connection.traceId}
                </dd>
              </div>
            )}
          </dl>
          {updateState.status !== "idle" && <ServerUpdateProgress state={updateState} />}
          {versionMismatch && canUpdate && updateState.status !== "running" && (
            <ServerUpdateAction
              environmentId={environment.environmentId}
              serverLabel={`${environment.label} server`}
              selfUpdate={resolveServerSelfUpdateCapability(environment.serverConfig)}
              desktopAppUpdate={supportsDesktopAppUpdate(environment.serverConfig)}
              threadContinuation={supportsServerUpdateThreadContinuation(environment.serverConfig)}
              targetVersion={versionMismatch.clientVersion}
              label={updateState.status === "failed" ? "Retry update" : "Update server"}
            />
          )}
          {environment.connection.error && (
            <p role="alert" className="text-sm text-destructive">
              {environment.connection.error}
            </p>
          )}
          {message && (
            <p role="status" className="text-sm text-muted-foreground">
              {message}
            </p>
          )}
        </section>
      )}
      {!detailsOnly &&
        (environment.environmentId === primary ? (
          <ConnectionsSettings hostOnly />
        ) : (
          <section className="space-y-2">
            <h2 className="text-base font-semibold">Hosting and network access</h2>
            <p className="text-[13px] text-muted-foreground">
              Network access, Tailscale and WSL are configured on the hosting desktop. Open this
              environment on its host to manage those settings.
            </p>
          </section>
        ))}
      {!detailsOnly && (
        <section data-settings-layout="environment" className="space-y-3">
          <div>
            <h2 className="text-base font-semibold">Editor handoff</h2>
            <p className="mt-1 text-xs leading-[18px] text-muted-foreground">
              Choose where files open when you use Open in editor.
            </p>
          </div>
          <EnvironmentEditorHandoffRow environment={environment} title="Open files with" />
        </section>
      )}
      {!detailsOnly && (
        <section className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold">Other environments</h2>
              <p className="mt-1 text-[13px] text-muted-foreground">
                Pair another host, or manage a saved connection.
              </p>
            </div>
            <Button
              data-environment-control
              size="sm"
              variant="outline"
              onClick={() =>
                void navigate({
                  to: "/environments",
                  search: { environment: environment.environmentId, tab: "connections", add: true },
                })
              }
            >
              Add environment
            </Button>
          </div>
          <div className="divide-y divide-border border-y border-border">
            {environments
              .filter((item) => item.environmentId !== environment.environmentId)
              .map((item) => (
                <div
                  key={item.environmentId}
                  className="flex flex-wrap items-center justify-between gap-4 py-5"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <EnvironmentIcon environmentId={item.environmentId} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {appearance[item.environmentId]?.alias || item.label}
                      </p>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {environmentConnectionKind(item)} ·{" "}
                        {item.displayUrl ?? "Managed connection"} ·{" "}
                        {item.connection.phase === "available" ? "Offline" : item.connection.phase}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <Button
                      data-environment-control
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        if (item.connection.phase !== "connected") void retry(item.environmentId);
                        void navigate({
                          to: "/environments",
                          search: { environment: item.environmentId, tab: "overview" },
                        });
                      }}
                    >
                      {item.connection.phase === "connected" ? "Inspect" : "Reconnect"}
                    </Button>
                    {item.environmentId !== primary &&
                      !item.relayManaged &&
                      !isDesktopLocalConnectionTarget(item.entry.target) && (
                        <Button
                          data-environment-control
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setRemoving(item)}
                        >
                          Remove
                        </Button>
                      )}
                  </div>
                </div>
              ))}
          </div>
        </section>
      )}
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
          <DialogFooter className="border-t">
            <Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void act("remove")}>
              {busy ? "Removing…" : "Remove environment"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
