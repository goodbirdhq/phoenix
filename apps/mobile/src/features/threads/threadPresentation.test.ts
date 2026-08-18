import { describe, expect, it } from "vite-plus/test";
import { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { resolveThreadStatus } from "./threadPresentation";

const lastReportedAt = "2026-01-01T00:00:00.000Z";
const lastReportedMs = Date.parse(lastReportedAt);

function runningThread(sessionUpdatedAt: string): EnvironmentThreadShell {
  return {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: { status: "running", updatedAt: sessionUpdatedAt },
  } as unknown as EnvironmentThreadShell;
}

describe("resolveThreadStatus", () => {
  it("reads as Working while the provider is reporting", () => {
    const status = resolveThreadStatus(runningThread(lastReportedAt), lastReportedMs + 30_000);
    expect(status?.label).toBe("Working");
    expect(status?.pulse).toBe(true);
  });

  it("says how long it has been quiet once the provider goes silent", () => {
    const status = resolveThreadStatus(
      runningThread(lastReportedAt),
      lastReportedMs + 32 * 60 * 1_000,
    );
    expect(status?.label).toBe("Quiet 32m");
    // A pulse implies progress. Nothing is arriving, so it stops.
    expect(status?.pulse).toBe(false);
    // Still the working hue: this is a fact about silence, not a failure.
    expect(status?.kind).toBe("working");
  });

  it("returns to Working the moment the provider reports again", () => {
    const nowMs = lastReportedMs + 32 * 60 * 1_000;
    const status = resolveThreadStatus(runningThread("2026-01-01T00:32:00.000Z"), nowMs);
    expect(status?.label).toBe("Working");
    expect(status?.pulse).toBe(true);
  });
});
