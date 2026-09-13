import { EnvironmentTableSearch } from "./EnvironmentTableSearch";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { desktopNetworkAccessStateAtom } from "../../state/desktopNetworkAccess";
import { isLoopbackHostname } from "../../environments/primary";
import { isQrShareableEndpoint } from "../settings/ConnectionsSettings.logic";
import { resolveDesktopPairingUrl } from "../settings/pairingUrls";
import { useRef, useState } from "react";
import * as DateTime from "effect/DateTime";
import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  type EnvironmentId,
  type AuthPairingCredentialResult,
} from "@t3tools/contracts";
import type { AuthAccessAction } from "@t3tools/client-runtime/state/auth";
import { PlusIcon, ShieldCheckIcon } from "lucide-react";
import { authEnvironment } from "../../state/auth";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentSessionState } from "../../state/session";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table";
import { QRCodeSvg } from "../ui/qr-code";

const SCOPE_LABELS: Record<AuthEnvironmentScope, string> = {
  "orchestration:read": "View environment",
  "orchestration:operate": "Operate tasks",
  "terminal:operate": "Use terminals",
  "review:write": "Write reviews",
  "access:read": "View access",
  "access:write": "Manage access",
  "relay:read": "View relay",
  "relay:write": "Manage relay",
};

export function EnvironmentAccess({ environmentId }: { environmentId: EnvironmentId }) {
  const session = useEnvironmentSessionState(environmentId);
  const canManage = session.data?.scopes?.includes("access:write") ?? false;
  const canRead = session.data?.scopes?.includes("access:read") ?? false;
  const access = useEnvironmentQuery(
    canRead ? authEnvironment.accessChanges({ environmentId, input: null }) : null,
  );
  const action = useAtomCommand(authEnvironment.action, "manage environment access");
  const baseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const network = useEnvironmentQuery(
    canRead && environmentId === primaryEnvironmentId && window.desktopBridge
      ? desktopNetworkAccessStateAtom
      : null,
  );
  const reachableBaseUrl =
    network.data?.advertisedEndpoints.find(isQrShareableEndpoint)?.httpBaseUrl ?? baseUrl;
  let shareEndpoint: string | null = null;
  if (reachableBaseUrl) {
    try {
      const url = new URL(reachableBaseUrl);
      if (!isLoopbackHostname(url.hostname) && ["http:", "https:"].includes(url.protocol))
        shareEndpoint = reachableBaseUrl;
    } catch {
      /* Invalid endpoints can still use a pairing code. */
    }
  }
  const [permissions, setPermissions] = useState<{
    label: string;
    scopes: readonly AuthEnvironmentScope[];
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<readonly AuthEnvironmentScope[]>(AuthStandardClientScopes);
  const [confirm, setConfirm] = useState<AuthAccessAction | null>(null);
  const [sharing, setSharing] = useState<AuthPairingCredentialResult | null>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [clientSearch, setClientSearch] = useState("");
  const [linkSearch, setLinkSearch] = useState("");
  const mutate = async (next: AuthAccessAction) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await action({ environmentId, action: next });
      if (result._tag === "Failure") {
        setError(
          "The action failed. Your changes are still here; check the connection and try again.",
        );
        return;
      }
      if (result.value && "credential" in result.value) {
        setSharing(result.value);
        setCreating(false);
        setLabel("");
      }
      setConfirm(null);
      access.refresh();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Copy failed. Select and copy the value below.");
    }
  };
  const shareUrl =
    sharing && shareEndpoint ? resolveDesktopPairingUrl(shareEndpoint, sharing.credential) : null;
  if (session.isPending && session.data === null)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Checking access permissions…
      </p>
    );
  if (session.hasError && session.data === null)
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not check access permissions. Reconnect this environment from Connections and try
        again.
      </p>
    );
  if (!canRead)
    return (
      <div className="space-y-3">
        <ShieldCheckIcon className="size-6 text-muted-foreground" />
        <h2 className="text-base font-semibold">Access is restricted</h2>
        <p className="text-sm text-muted-foreground">
          This session needs View access permission to inspect pairing links and authorized clients.
        </p>
      </div>
    );
  const snapshot = access.data?.type === "snapshot" ? access.data.payload : null;
  const clients = snapshot?.clientSessions.map((client) => ({
    ...client,
    lastSeenLabel: client.connected
      ? "Connected"
      : client.lastConnectedAt
        ? new Date(DateTime.toEpochMillis(client.lastConnectedAt)).toLocaleString()
        : "Not connected yet",
  }));
  const links = snapshot?.pairingLinks.map((link) => ({
    ...link,
    expiryLabel: new Date(DateTime.toEpochMillis(link.expiresAt)).toLocaleString(),
  }));
  const visibleClients = clients?.filter((client) =>
    [
      client.client.label ?? client.client.os ?? "Client",
      client.client.os,
      client.client.browser ?? client.method,
      client.lastSeenLabel,
      client.current ? "This client" : permissionSummary(client.scopes),
    ]
      .join(" ")
      .toLowerCase()
      .includes(clientSearch.trim().toLowerCase()),
  );
  const visibleLinks = links?.filter((link) =>
    [
      link.label ?? "Pairing link",
      permissionSummary(link.scopes),
      "permissions",
      "Ready to pair",
      link.expiryLabel,
    ]
      .join(" ")
      .toLowerCase()
      .includes(linkSearch.trim().toLowerCase()),
  );
  return (
    <div className="space-y-6">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {access.error && (
        <div role="alert" className="flex items-center gap-3 text-[13px]">
          <span>Could not load access: {access.error}</span>
          <Button variant="outline" onClick={access.refresh}>
            Retry
          </Button>
        </div>
      )}
      <section className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Authorized clients</h2>
            <p className="mt-1 text-xs leading-[18px] text-muted-foreground">
              Devices with access to this environment.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <EnvironmentTableSearch
              label="Search clients"
              value={clientSearch}
              onChange={setClientSearch}
            />
            <Button
              data-environment-control
              size="sm"
              variant="outline"
              disabled={!canManage || busy || !snapshot?.clientSessions.some((c) => !c.current)}
              onClick={() => setConfirm({ kind: "revokeOthers" })}
            >
              Revoke other clients
            </Button>{" "}
            <Button
              data-environment-control
              size="sm"
              disabled={!canManage}
              onClick={() => {
                setError(null);
                setCreating(true);
              }}
            >
              <PlusIcon className="size-4" />
              Create pairing link
            </Button>
          </div>
        </div>
        <Table className="environment-table">
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead className="w-[220px]">Last seen</TableHead>
              <TableHead className="w-[180px]">Access</TableHead>
              <TableHead className="w-[252px]">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleClients?.map((client) => (
              <TableRow key={client.sessionId}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <div className="text-[13px]">
                      {client.client.label ?? client.client.os ?? "Client"}
                      <p className="mt-1 text-xs leading-[18px] text-muted-foreground">
                        {client.client.os} · {client.client.browser ?? client.method}
                      </p>
                    </div>
                  </div>
                </TableCell>
                <TableCell>{client.lastSeenLabel}</TableCell>
                <TableCell className="text-muted-foreground">
                  {client.current ? "This client" : permissionSummary(client.scopes)}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-4">
                    <Button
                      data-environment-control
                      size="sm"
                      data-environment-action
                      variant="ghost"
                      onClick={() =>
                        setPermissions({
                          label: client.client.label ?? client.client.os ?? "Client",
                          scopes: client.scopes,
                        })
                      }
                    >
                      View permissions
                    </Button>
                    <Button
                      data-environment-control
                      size="sm"
                      variant="outline"
                      disabled={!canManage || busy}
                      onClick={() =>
                        setConfirm({ kind: "revokeClient", sessionId: client.sessionId })
                      }
                    >
                      Revoke
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!visibleClients?.length && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  {access.isPending && !snapshot
                    ? "Loading clients…"
                    : snapshot?.clientSessions.length
                      ? "No clients match your search."
                      : "No authorized clients."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>
      <section className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Pairing links</h2>
            <p className="mt-1 text-xs leading-[18px] text-muted-foreground">
              Active one-time invitations. Used or expired links can no longer pair a device.
            </p>
          </div>
          <EnvironmentTableSearch
            label="Search pairing links"
            value={linkSearch}
            onChange={setLinkSearch}
          />
        </div>
        <Table className="environment-table">
          <TableHeader>
            <TableRow>
              <TableHead>Pairing link</TableHead>
              <TableHead className="w-[220px]">Expiry</TableHead>
              <TableHead className="w-[180px]">Status</TableHead>
              <TableHead className="w-[252px]">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleLinks?.map((link) => (
              <TableRow key={link.id}>
                <TableCell>
                  <span className="flex items-center gap-3 text-[13px]">
                    {link.label ?? "Pairing link"}
                  </span>
                  <p className="mt-1 text-xs leading-[18px] text-muted-foreground">
                    {permissionSummary(link.scopes)} permissions
                  </p>
                </TableCell>
                <TableCell>{link.expiryLabel}</TableCell>
                <TableCell>
                  <span className="text-emerald-700 dark:text-emerald-400">Ready to pair</span>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    <Button
                      data-environment-control
                      size="sm"
                      variant="ghost"
                      disabled={!canManage || busy}
                      onClick={() => setConfirm({ kind: "revokeLink", id: link.id })}
                    >
                      Revoke
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!visibleLinks?.length && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-muted-foreground">
                  {access.isPending && !snapshot
                    ? "Loading pairing links…"
                    : snapshot?.pairingLinks.length
                      ? "No pairing links match your search."
                      : "No active pairing links."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>

      <section className="space-y-5">
        <div>
          <h2 className="text-base font-semibold">This client’s permissions</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Administrative access includes the ability to grant or revoke access.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {session.data?.scopes?.map((scope) => (
            <span key={scope} className="rounded-md bg-muted px-2.5 py-2 text-[11px]">
              {SCOPE_LABELS[scope]}
            </span>
          ))}
        </div>
        <p className="rounded-lg border border-border p-4 text-xs leading-[18px] text-muted-foreground">
          Revoked clients must use a new pairing link to reconnect. Revoking other clients keeps
          this client connected.
        </p>
      </section>
      <Dialog
        open={permissions !== null}
        onOpenChange={(open) => {
          if (!open) setPermissions(null);
        }}
      >
        <DialogPopup className="usage-surface environment-surface rounded-[14px] sm:max-w-[620px]">
          <DialogHeader>
            <DialogTitle>Permissions for {permissions?.label}</DialogTitle>
            <DialogDescription>
              Permissions granted to this client on the selected environment.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            {permissions?.scopes.map((scope) => (
              <p key={scope} className="flex items-center gap-2 text-sm">
                <ShieldCheckIcon className="size-4 text-muted-foreground" />
                {SCOPE_LABELS[scope]}
              </p>
            ))}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPermissions(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (!busy) setCreating(open);
        }}
      >
        <DialogPopup className="usage-surface environment-surface rounded-[14px] sm:max-w-[620px]">
          <DialogHeader>
            <DialogTitle>Create pairing link</DialogTitle>
            <DialogDescription>
              Choose the access granted to the connecting client.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-5">
            <label className="block space-y-2 text-sm">
              <span>Label (optional)</span>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="My laptop"
              />
            </label>
            <div className="flex gap-2">
              <Button
                data-environment-control
                variant="outline"
                size="sm"
                onClick={() => setScopes(AuthStandardClientScopes)}
              >
                Standard
              </Button>
              <Button
                data-environment-control
                variant="outline"
                size="sm"
                onClick={() => setScopes(AuthAdministrativeScopes)}
              >
                Administrator
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {Object.entries(SCOPE_LABELS).map(([scope, title]) => (
                <label key={scope} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope as AuthEnvironmentScope)}
                    onChange={(e) =>
                      setScopes(
                        e.target.checked
                          ? [...scopes, scope as AuthEnvironmentScope]
                          : scopes.filter((s) => s !== scope),
                      )
                    }
                  />
                  {title}
                </label>
              ))}
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter className="border-t">
            <Button variant="outline" disabled={busy} onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || !scopes.length}
              onClick={() =>
                void mutate({
                  kind: "create",
                  ...(label.trim() ? { label: label.trim() } : {}),
                  scopes,
                })
              }
            >
              {busy ? "Creating…" : "Create link"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={sharing !== null}
        onOpenChange={(open) => {
          if (!open) setSharing(null);
        }}
      >
        <DialogPopup className="usage-surface environment-surface rounded-[14px] sm:max-w-[620px]">
          <DialogHeader>
            <DialogTitle>Share pairing link</DialogTitle>
            <DialogDescription>
              This credential can be used once. Share it with the client you want to connect.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {shareUrl && (
              <div className="flex justify-center">
                <QRCodeSvg
                  value={shareUrl}
                  size={180}
                  level="M"
                  marginSize={2}
                  title="Scan to pair this environment"
                />
              </div>
            )}
            {!shareUrl && (
              <p className="text-sm text-muted-foreground">
                No address reachable by another device is available here. Use this code with the
                host’s network address, or enable network access on the host.
              </p>
            )}
            <Input
              aria-label="Pairing credential"
              readOnly
              value={shareUrl ?? sharing?.credential ?? ""}
              onFocus={(e) => e.target.select()}
            />
            <div className="flex gap-2">
              {shareUrl && (
                <Button variant="outline" onClick={() => void copy(shareUrl)}>
                  Copy URL
                </Button>
              )}
              <Button variant="outline" onClick={() => sharing && void copy(sharing.credential)}>
                Copy code
              </Button>
            </div>
            <p role="status" className="text-sm text-muted-foreground">
              {copyStatus}
            </p>
          </DialogPanel>
          <DialogFooter className="border-t">
            <Button onClick={() => setSharing(null)}>Done</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
      >
        <DialogPopup className="usage-surface environment-surface rounded-[14px] sm:max-w-[620px]">
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === "revokeLink" ? "Revoke pairing link?" : "Revoke client access?"}
            </DialogTitle>
            <DialogDescription>
              {confirm?.kind === "revokeLink"
                ? "This link will no longer let another client connect."
                : "Affected clients must pair again to reconnect. Revoking this client will end your connection."}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <DialogPanel>
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            </DialogPanel>
          )}
          <DialogFooter className="border-t">
            <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => confirm && void mutate(confirm)}
            >
              {busy ? "Revoking…" : "Revoke access"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function permissionSummary(scopes: readonly AuthEnvironmentScope[]) {
  if (scopes.includes("access:write")) return "Administrative";
  if (
    scopes.length === AuthStandardClientScopes.length &&
    AuthStandardClientScopes.every((scope) => scopes.includes(scope))
  )
    return "Standard";
  if (scopes.length === 1 && scopes[0] === "orchestration:read") return "Read only";
  return "Custom permissions";
}
