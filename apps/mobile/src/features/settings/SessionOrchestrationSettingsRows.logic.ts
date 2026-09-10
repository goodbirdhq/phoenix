import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { AuthOrchestrationOperateScope, type AuthSessionState } from "@t3tools/contracts";

export function resolveOrchestrationSettingsAccess(input: {
  readonly phase: EnvironmentConnectionPhase;
  readonly session: Pick<AuthSessionState, "authenticated" | "scopes"> | null;
  readonly hasError: boolean;
  readonly isPending: boolean;
}) {
  if (input.phase !== "connected") {
    return { disabled: true, detail: "Available when this environment is connected." };
  }
  if (input.hasError) {
    return {
      disabled: true,
      detail: "Unable to verify settings access. Reopen settings to retry.",
    };
  }
  if (input.isPending || input.session === null) {
    return { disabled: true, detail: "Checking settings access…" };
  }
  if (
    !input.session.authenticated ||
    !input.session.scopes?.includes(AuthOrchestrationOperateScope)
  ) {
    return { disabled: true, detail: "Read-only connection. Settings access is required." };
  }
  return {
    disabled: false,
    detail: "Let agents suggest and coordinate child sessions. Applies to all clients.",
  };
}
