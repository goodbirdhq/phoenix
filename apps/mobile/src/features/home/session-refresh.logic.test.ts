import { describe, expect, it } from "vite-plus/test";
import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  evaluateSessionRefresh,
  sessionRefreshFailure,
  sessionRefreshTargets,
} from "./session-refresh.logic";

const snapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  projects: [],
  threads: [],
  updatedAt: "2026-09-07T00:00:00.000Z",
};
const connected: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  generation: 2,
};
const live: EnvironmentShellState = {
  status: "live",
  error: Option.none(),
  snapshot: Option.some({ ...snapshot }),
};
const input = {
  networkStatus: "online" as const,
  initialConnection: connected,
  state: { ...connected },
  initialSnapshot: snapshot,
  shell: live,
};

describe("session refresh completion", () => {
  it("accepts a reconnect that reuses the interrupted connecting generation", () => {
    const initialConnection = { ...connected, phase: "connecting" as const };
    expect(evaluateSessionRefresh({ ...input, initialConnection })).toEqual({ status: "ready" });
  });
  it("does not accept a live update on the original connection", () => {
    expect(evaluateSessionRefresh({ ...input, state: connected })).toEqual({ status: "pending" });
  });
  it("waits for a new snapshot and the synchronization marker", () => {
    expect(
      evaluateSessionRefresh({ ...input, shell: { ...live, snapshot: Option.some(snapshot) } }),
    ).toEqual({ status: "pending" });
    expect(
      evaluateSessionRefresh({ ...input, shell: { ...live, status: "synchronizing" } }),
    ).toEqual({ status: "pending" });
    expect(evaluateSessionRefresh(input)).toEqual({ status: "ready" });
  });
  it("waits while the replacement connection is still establishing", () => {
    expect(
      evaluateSessionRefresh({ ...input, state: { ...connected, phase: "connecting" } }),
    ).toEqual({ status: "pending" });
  });
  it("reports offline and replacement connection failures", () => {
    expect(evaluateSessionRefresh({ ...input, networkStatus: "offline" }).status).toBe("error");
    for (const phase of ["blocked", "backoff"] as const) {
      expect(evaluateSessionRefresh({ ...input, state: { ...connected, phase } }).status).toBe(
        "error",
      );
    }
  });
  it("does not fail a retry because the initial connection is blocked", () => {
    const blocked = { ...connected, phase: "blocked" as const };
    expect(
      evaluateSessionRefresh({ ...input, initialConnection: blocked, state: blocked }),
    ).toEqual({ status: "pending" });
  });
  it("reports a shell error after connecting, and waits when no snapshot exists", () => {
    expect(
      evaluateSessionRefresh({
        ...input,
        shell: { ...live, error: Option.some("Snapshot failed") },
      }),
    ).toEqual({ status: "error", message: "Snapshot failed" });
    expect(
      evaluateSessionRefresh({ ...input, shell: { ...live, snapshot: Option.none() } }),
    ).toEqual({ status: "pending" });
  });
});

describe("refresh scope and failures", () => {
  const environments = [
    { environmentId: EnvironmentId.make("first") },
    { environmentId: EnvironmentId.make("second") },
  ];
  it("refreshes all saved environments or only the selected environment", () => {
    expect(sessionRefreshTargets(environments, null)).toEqual(environments);
    expect(sessionRefreshTargets(environments, environments[1]!.environmentId)).toEqual([
      environments[1],
    ]);
    expect(sessionRefreshTargets(environments, EnvironmentId.make("removed"))).toEqual([]);
  });
  it("does not report a global failure when one environment succeeds", () => {
    expect(
      sessionRefreshFailure([
        { status: "rejected", reason: new Error("Asleep") },
        { status: "fulfilled", value: undefined },
      ]),
    ).toBeNull();
  });
  it("reports failure when every target failed and ignores an empty catalog", () => {
    const error = new Error("Unavailable");
    expect(sessionRefreshFailure([{ status: "rejected", reason: error }])).toBe(error);
    expect(sessionRefreshFailure([])).toBeNull();
  });
});
