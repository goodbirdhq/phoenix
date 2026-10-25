import type { EnvironmentId } from "@t3tools/contracts";

import { usePhoenixCloudAccount } from "../../hooks/usePhoenixCloudAccount";
import { resolvePhoenixCloudOwnershipView } from "../PhoenixCloudOwnershipGate.logic";
import { PhoenixCloudLinkForm } from "../PhoenixCloudLinkForm";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function PhoenixCloudSettings({
  environmentId,
  environmentLabel,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
}) {
  const account = usePhoenixCloudAccount(environmentId);
  const view = resolvePhoenixCloudOwnershipView({
    state: account.status.data?.state,
    error: account.status.error,
    locallySignedOut: account.signedOut,
  });
  const signedIn =
    !account.signedOut && account.status.data?.state === "signed-in" ? account.status.data : null;
  return (
    <SettingsSection title={`Phoenix Cloud · ${environmentLabel}`}>
      <SettingsRow
        title="Installation ownership"
        description={
          account.verificationError ??
          account.status.error ??
          "This installation must be linked to your Phoenix Cloud account."
        }
      >
        <Button
          variant="outline"
          disabled={account.status.isPending || account.verifying}
          onClick={() => void account.verify()}
        >
          {account.verifying ? "Checking…" : "Refresh"}
        </Button>
      </SettingsRow>
      {view === "app" && signedIn ? (
        <SettingsRow
          title={signedIn.account.email}
          description={`${signedIn.installation.name} · ${signedIn.installation.kind} · ${signedIn.cloudUrl}`}
        >
          <Button
            variant="outline"
            disabled={!account.allowed || account.loggingOut}
            onClick={() => void account.logout()}
          >
            Logout
          </Button>
        </SettingsRow>
      ) : account.loggingOut ? (
        <SettingsRow title="Logging out…" />
      ) : account.logoutError ? (
        <SettingsRow title="Could not finish logout" description={account.logoutError}>
          <Button variant="outline" onClick={() => void account.logout()}>
            Retry logout
          </Button>
        </SettingsRow>
      ) : view === "link" ? (
        <div className="p-3 sm:p-4">
          <PhoenixCloudLinkForm
            key={environmentId}
            environmentId={environmentId}
            environmentLabel={environmentLabel}
          />
        </div>
      ) : (
        <SettingsRow
          title={
            view === "loading" ? "Checking installation ownership…" : "Phoenix Cloud is unavailable"
          }
          description={
            view === "unavailable"
              ? "Your saved account has been kept. Refresh to verify ownership again."
              : "Connecting to this environment."
          }
        />
      )}
    </SettingsSection>
  );
}
