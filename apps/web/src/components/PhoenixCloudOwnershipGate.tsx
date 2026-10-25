import { resolvePhoenixCloudOwnershipView } from "./PhoenixCloudOwnershipGate.logic";
import { useEffect, useEffectEvent, type ReactNode } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { isElectron } from "../env";
import { usePhoenixCloudAccount } from "../hooks/usePhoenixCloudAccount";
import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { useActiveEnvironmentId } from "../state/entities";
import { PhoenixCloudLinkForm } from "./PhoenixCloudLinkForm";
import { Button } from "./ui/button";

export function PhoenixCloudOwnershipGate({
  children,
  requireEnvironment = false,
}: {
  children: ReactNode;
  requireEnvironment?: boolean;
}) {
  const primaryId = usePrimaryEnvironmentId();
  const activeId = useActiveEnvironmentId();
  const environmentId = requireEnvironment ? primaryId : (primaryId ?? activeId);
  const environment = useEnvironment(environmentId);
  // Hosted clients must still be able to choose and pair an environment.
  if (!environmentId)
    return requireEnvironment ? (
      <main
        className="flex h-dvh items-center justify-center bg-background p-6 text-sm text-muted-foreground"
        role="status"
      >
        Connecting to your installation…
      </main>
    ) : (
      children
    );
  return (
    <EnvironmentOwnershipGate
      key={environmentId}
      environmentId={environmentId}
      environmentLabel={environment?.label ?? "Phoenix installation"}
    >
      {children}
    </EnvironmentOwnershipGate>
  );
}

function EnvironmentOwnershipGate({
  environmentId,
  environmentLabel,
  children,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  children: ReactNode;
}) {
  const account = usePhoenixCloudAccount(environmentId);
  const refresh = useEffectEvent(() => {
    if (document.visibilityState === "visible") account.status.refresh();
  });
  useEffect(() => {
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  const view = resolvePhoenixCloudOwnershipView({
    state: account.status.data?.state,
    error: account.status.error,
    locallySignedOut: account.signedOut,
  });
  if (view === "app") return children;
  const linking = view === "link";
  const failed = view === "unavailable";
  return (
    <main className="flex h-dvh min-h-0 items-center justify-center overflow-y-auto scrollbar-gutter-both bg-background p-6 text-foreground">
      {isElectron ? <div aria-hidden className="drag-region fixed inset-x-0 top-0 h-10" /> : null}
      <div className="flex w-full max-w-md flex-col gap-5">
        <p className="text-sm text-muted-foreground">{environmentLabel}</p>
        <h1 className="text-xl font-semibold">
          {linking
            ? "Link this installation to Phoenix Cloud"
            : failed
              ? "Phoenix Cloud is unavailable"
              : "Checking installation ownership…"}
        </h1>
        {account.loggingOut ? (
          <p role="status" className="text-sm text-muted-foreground">
            Logging out…
          </p>
        ) : account.logoutError ? (
          <>
            <p role="alert" className="text-sm text-muted-foreground">
              {account.logoutError}
            </p>
            <Button variant="outline" onClick={() => void account.logout()}>
              Retry logout
            </Button>
          </>
        ) : linking ? (
          <PhoenixCloudLinkForm
            key={environmentId}
            environmentId={environmentId}
            environmentLabel={environmentLabel}
          />
        ) : (
          <>
            <p role={failed ? "alert" : "status"} className="text-sm text-muted-foreground">
              {account.verificationError ??
                account.status.error ??
                (failed
                  ? "Your saved account has been kept. Phoenix must verify installation ownership before you can continue."
                  : "Connecting to your environment.")}
            </p>
            <Button
              variant="outline"
              disabled={account.status.isPending || account.verifying}
              onClick={() => void account.verify()}
            >
              {account.verifying ? "Checking…" : "Retry"}
            </Button>
          </>
        )}
      </div>
    </main>
  );
}
