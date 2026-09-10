import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { resolveOrchestrationSettingsAccess } from "./SessionOrchestrationSettingsRows.logic";

/** Orchestration is owned by each environment and applies to every connected client. */
export function SessionOrchestrationSettingsRows() {
  const { environments } = useEnvironments();
  return environments.map((environment) => (
    <SessionOrchestrationSettingsRow key={environment.environmentId} environment={environment} />
  ));
}

function SessionOrchestrationSettingsRow({
  environment,
}: {
  environment: EnvironmentPresentation;
}) {
  const connected = environment.connection.phase === "connected";
  const session = useEnvironmentQuery(
    connected ? environmentSession.sessionStateAtom(environment.environmentId) : null,
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "session orchestration settings update",
    reportFailure: true,
  });

  const settings = environment.serverConfig?.settings;
  if (settings === undefined) return null;

  const access = resolveOrchestrationSettingsAccess({
    phase: environment.connection.phase,
    session: session.data,
    hasError: session.error !== null,
    isPending: session.isPending,
  });
  return (
    <SettingsSwitchRow
      key={environment.environmentId}
      icon="arrow.triangle.branch"
      label="Session orchestration"
      subtitle={`${environment.label}: ${access.detail}`}
      disabled={access.disabled}
      value={settings.enableSessionOrchestration}
      onValueChange={(value) => {
        if (access.disabled) return;
        void updateSettings({
          environmentId: environment.environmentId,
          input: { patch: { enableSessionOrchestration: value } },
        });
      }}
    />
  );
}
