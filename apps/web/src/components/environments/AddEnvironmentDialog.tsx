import { parseManualDesktopSshTarget } from "../../connection/sshTarget";
import { useState } from "react";
import type { EnvironmentId, DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import { LinkIcon, TerminalIcon } from "lucide-react";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import { desktopSshHostsStateAtom } from "../../state/desktopSshHosts";
import { useEnvironmentQuery } from "../../state/query";
import { connectPairing, connectSshEnvironment } from "../../connection/onboarding";
import { useAtomCommand } from "../../state/use-atom-command";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ENVIRONMENT_ICONS, type EnvironmentIconKind } from "./EnvironmentIcon";

export function AddEnvironmentDialog({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (id: EnvironmentId) => void;
}) {
  const [step, setStep] = useState(0);
  const [method, setMethod] = useState<"remote" | "ssh">("remote");
  const [remoteHost, setRemoteHost] = useState("");
  const [selectedSshTarget, setSelectedSshTarget] = useState<DesktopSshEnvironmentTarget | null>(
    null,
  );
  const [sshHost, setSshHost] = useState("");
  const host = method === "remote" ? remoteHost : sshHost;
  const setHost = (value: string) => {
    if (method === "ssh") {
      setSelectedSshTarget(null);
      setSshHost(value);
      return;
    }
    try {
      const parsed = resolveRemotePairingTarget({ pairingUrl: value });
      setRemoteHost(parsed.httpBaseUrl);
      setCode(parsed.credential);
    } catch {
      setRemoteHost(value);
    }
  };
  const discovery = useEnvironmentQuery(
    method === "ssh" && step === 1 && window.desktopBridge ? desktopSshHostsStateAtom : null,
  );
  const [code, setCode] = useState("");
  const [alias, setAlias] = useState("");
  const [username, setUsername] = useState("");
  const [port, setPort] = useState("");
  const [icon, setIcon] = useState<EnvironmentIconKind>("desktop");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const appearance = useClientSettings((s) => s.environmentAppearance);
  const update = useUpdateClientSettings();
  const pair = useAtomCommand(connectPairing, { reportFailure: false });
  const ssh = useAtomCommand(connectSshEnvironment, { reportFailure: false });
  const submit = async () => {
    if (busy) return;
    if (step === 0) {
      setStep(1);
      return;
    }
    setError(null);
    if (!host.trim()) {
      setError("Enter an environment address or SSH host.");
      return;
    }
    if (
      method === "ssh" &&
      port &&
      (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    ) {
      setError("Enter a port between 1 and 65535.");
      return;
    }
    setBusy(true);
    try {
      const result =
        method === "ssh"
          ? await ssh({
              target: {
                ...parseManualDesktopSshTarget({ host, username, port }),
                ...(selectedSshTarget
                  ? { alias: selectedSshTarget.alias, hostname: selectedSshTarget.hostname }
                  : {}),
              },
              ...(alias.trim() ? { label: alias.trim() } : {}),
            })
          : await pair(
              code.trim()
                ? { host: host.trim(), pairingCode: code.trim() }
                : { pairingUrl: host.trim() },
            );
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(
            failure instanceof Error
              ? failure.message
              : "Connection failed. Check the details and try again.",
          );
        }
        return;
      }
      update({
        environmentAppearance: { ...appearance, [result.value]: { alias: alias.trim(), icon } },
      });
      onAdded(result.value);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Connection failed. Check the details and try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="usage-surface environment-surface rounded-[14px] sm:max-w-[620px]">
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add environment</DialogTitle>
            <DialogDescription>
              {step === 0
                ? "Choose how to connect to another environment."
                : "Connect and save this environment on your client."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <fieldset disabled={busy} className="min-w-0 space-y-5">
              <ol className="flex gap-3 text-xs text-muted-foreground">
                <li aria-current={step === 0 ? "step" : undefined}>1 · Method</li>
                <li aria-current={step === 1 ? "step" : undefined}>2 · Connection</li>
              </ol>
              {step === 0 ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {(
                    [
                      {
                        id: "remote",
                        title: "Remote link",
                        description: "Pair with a URL or host and pairing code.",
                        Icon: LinkIcon,
                      },
                      ...(window.desktopBridge
                        ? [
                            {
                              id: "ssh",
                              title: "SSH",
                              description: "Use this computer’s SSH configuration and credentials.",
                              Icon: TerminalIcon,
                            },
                          ]
                        : []),
                    ] as const
                  ).map(({ id, title, description, Icon }) => (
                    <label
                      key={id}
                      className="cursor-pointer rounded-lg border p-5 has-[:checked]:border-foreground has-[:checked]:bg-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
                    >
                      <input
                        className="sr-only"
                        type="radio"
                        name="method"
                        value={id}
                        checked={method === id}
                        onChange={() => setMethod(id as "remote" | "ssh")}
                      />
                      <Icon className="mb-3 size-5" />
                      <span className="block text-sm font-medium">{title}</span>
                      <span className="mt-2 block text-xs text-muted-foreground">
                        {description}
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <>
                  <label className="block space-y-2 text-sm">
                    <span>Display name (optional)</span>
                    <Input
                      value={alias}
                      onChange={(e) => setAlias(e.target.value)}
                      placeholder="Build server"
                    />
                  </label>
                  <label className="block space-y-2 text-sm">
                    <span>{method === "remote" ? "Pairing URL or host" : "SSH host or alias"}</span>
                    <Input
                      required
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                      placeholder={
                        method === "remote" ? "https://environment.example" : "build-server"
                      }
                    />
                  </label>
                  {method === "remote" ? (
                    <label className="block space-y-2 text-sm">
                      <span>Pairing code</span>
                      <Input
                        type="password"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        autoComplete="off"
                      />
                      <span className="text-xs text-muted-foreground">
                        Leave empty when using a complete pairing URL.
                      </span>
                    </label>
                  ) : (
                    <div className="grid grid-cols-2 gap-4">
                      <label className="space-y-2 text-sm">
                        <span>Username (optional)</span>
                        <Input value={username} onChange={(e) => setUsername(e.target.value)} />
                      </label>
                      <label className="space-y-2 text-sm">
                        <span>Port (optional)</span>
                        <Input
                          value={port}
                          inputMode="numeric"
                          placeholder="22"
                          onChange={(e) => setPort(e.target.value)}
                        />
                      </label>
                    </div>
                  )}
                  {method === "ssh" && (
                    <section className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-medium">Suggested hosts</h3>
                        <Button
                          data-environment-control
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={discovery.isPending}
                          onClick={discovery.refresh}
                        >
                          Refresh
                        </Button>
                      </div>
                      {discovery.error && (
                        <p role="alert" className="text-xs text-destructive">
                          {discovery.error}
                        </p>
                      )}
                      <div className="max-h-36 overflow-y-auto">
                        {discovery.data?.map((target) => (
                          <div
                            key={`${target.alias}:${target.hostname}:${target.port}`}
                            className="flex items-center justify-between gap-3 border-t py-3"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm">{target.alias}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {target.username ? `${target.username}@` : ""}
                                {target.hostname}
                              </p>
                            </div>
                            <Button
                              data-environment-control
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setSelectedSshTarget(target);
                                setSshHost(target.alias);
                                setUsername(target.username ?? "");
                                setPort(target.port === null ? "" : String(target.port));
                              }}
                            >
                              Use host
                            </Button>
                          </div>
                        ))}
                      </div>
                      {discovery.data?.length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          No hosts discovered. Enter a host above.
                        </p>
                      )}
                    </section>
                  )}
                  <fieldset>
                    <legend className="mb-2 text-sm">Environment icon</legend>
                    <div className="flex gap-3">
                      {Object.entries(ENVIRONMENT_ICONS).map(([kind, Icon]) => (
                        <label
                          key={kind}
                          className="flex flex-1 cursor-pointer flex-col items-center gap-2 rounded-lg border p-3 has-[:checked]:border-foreground has-[:checked]:bg-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
                        >
                          <input
                            className="sr-only"
                            type="radio"
                            name="icon"
                            value={kind}
                            checked={icon === kind}
                            onChange={() => setIcon(kind as EnvironmentIconKind)}
                          />
                          <Icon className="size-5" />
                          <span className="text-sm capitalize">{kind}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </fieldset>
          </DialogPanel>
          <DialogFooter className="border-t">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => (step ? setStep(0) : onClose())}
            >
              {step ? "Back" : "Cancel"}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Connecting…" : step ? "Add environment" : "Continue"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
