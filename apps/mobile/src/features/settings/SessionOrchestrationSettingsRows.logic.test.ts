import { describe, expect, it } from "vite-plus/test";
import { resolveOrchestrationSettingsAccess } from "./SessionOrchestrationSettingsRows.logic";

describe("orchestration settings access", () => {
  const writableSession = { authenticated: true, scopes: ["orchestration:operate"] } as const;

  it("keeps writable, read-only and offline environments independent", () => {
    const environments = [
      { phase: "connected", session: writableSession, hasError: false, isPending: false },
      {
        phase: "connected",
        session: { authenticated: true, scopes: ["orchestration:read"] },
        hasError: false,
        isPending: false,
      },
      { phase: "offline", session: writableSession, hasError: false, isPending: false },
    ] as const;
    expect(
      environments.map((environment) => resolveOrchestrationSettingsAccess(environment).disabled),
    ).toEqual([false, true, true]);
    expect(resolveOrchestrationSettingsAccess(environments[1]).detail).toContain("Read-only");
  });

  it.each(["available", "offline", "connecting", "reconnecting", "error"] as const)(
    "disables cached settings during %s even with previously granted write access",
    (phase) => {
      expect(
        resolveOrchestrationSettingsAccess({
          phase,
          session: writableSession,
          hasError: false,
          isPending: false,
        }).disabled,
      ).toBe(true);
    },
  );

  it("waits for permissions and reports verification failures without allowing writes", () => {
    const input = { phase: "connected", session: null, hasError: false, isPending: false } as const;
    expect(resolveOrchestrationSettingsAccess(input)).toEqual({
      disabled: true,
      detail: "Checking settings access…",
    });
    expect(
      resolveOrchestrationSettingsAccess({ ...input, session: writableSession, isPending: true })
        .disabled,
    ).toBe(true);
    const failed = resolveOrchestrationSettingsAccess({
      ...input,
      hasError: true,
      session: writableSession,
    });
    expect(failed.disabled).toBe(true);
    expect(failed.detail).toContain("Unable to verify");
  });

  it("requires both authentication and an explicitly granted write scope", () => {
    for (const session of [
      { authenticated: false, scopes: ["orchestration:operate"] },
      { authenticated: true },
      { authenticated: true, scopes: [] },
    ] as const) {
      expect(
        resolveOrchestrationSettingsAccess({
          phase: "connected",
          session,
          hasError: false,
          isPending: false,
        }).disabled,
      ).toBe(true);
    }
  });
});
