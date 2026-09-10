import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

/** Orchestration is owned by each environment and applies to every connected client. */
export function SessionOrchestrationSettingsRows() {
  const { environments } = useEnvironments();
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "session orchestration settings update",
    reportFailure: true,
  });

  return environments.map((environment) => {
    const settings = environment.serverConfig?.settings;
    if (settings === undefined) return null;

    const connected = environment.connection.phase === "connected";
    return (
      <SettingsSwitchRow
        key={environment.environmentId}
        icon="arrow.triangle.branch"
        label="Session orchestration"
        subtitle={
          connected
            ? `${environment.label}: let agents suggest and coordinate child sessions. Applies to all clients.`
            : `${environment.label}: reconnect to change this setting.`
        }
        disabled={!connected}
        value={settings.enableSessionOrchestration}
        onValueChange={(value) => {
          void updateSettings({
            environmentId: environment.environmentId,
            input: { patch: { enableSessionOrchestration: value } },
          });
        }}
      />
    );
  });
}
