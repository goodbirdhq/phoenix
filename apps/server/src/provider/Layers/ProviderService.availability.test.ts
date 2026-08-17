import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  availabilityAt,
  availabilityFromRuntimeEvent,
  claimAvailabilityRefresh,
  clearAvailabilityForReconciledAdapters,
  mergeProviderAvailability,
  retainStateForReconciledAdapters,
} from "./ProviderService.ts";

const claudeInstanceId = ProviderInstanceId.make("claude-work");

const claudeCliSnapshot = {
  status: "available",
  source: "claude_cli_usage",
  observedAt: "2026-08-17T20:45:00.000Z",
  account: {
    id: "claude:org-1:maintainer@example.com",
    verification: "native_verified",
    displayName: "maintainer@example.com",
  },
  windows: [{ kind: "session", label: "Current session", usedPercent: 5 }],
} as const;

const codexRateLimitEvent = {
  type: "account.rate-limits.updated",
  eventId: EventId.make("availability-event"),
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex-personal"),
  threadId: ThreadId.make("availability-thread"),
  createdAt: "2026-08-15T12:00:00.000Z",
  payload: {
    rateLimits: {
      rateLimits: {
        primary: { usedPercent: 40, resetsAt: 1_786_272_000, windowDurationMins: 300 },
        secondary: { usedPercent: 100, resetsAt: 1_786_331_400, windowDurationMins: 10_080 },
      },
    },
  },
} satisfies ProviderRuntimeEvent;

describe("availabilityFromRuntimeEvent", () => {
  it("preserves Codex's two native windows without combining account instances", () => {
    expect(availabilityFromRuntimeEvent(codexRateLimitEvent)).toMatchObject({
      status: "limited",
      source: "codex_app_server",
      observedAt: "2026-08-15T12:00:00.000Z",
      windows: [
        { kind: "primary", usedPercent: 40, windowDurationMins: 300 },
        { kind: "secondary", usedPercent: 100, windowDurationMins: 10_080 },
      ],
    });
  });

  it("keeps Claude native events honest until its SDK publishes a stable quota shape", () => {
    const event = {
      ...codexRateLimitEvent,
      provider: ProviderDriverKind.make("claudeAgent"),
    } satisfies ProviderRuntimeEvent;
    expect(availabilityFromRuntimeEvent(event)).toEqual({
      status: "unknown",
      source: "claude_agent_sdk",
      observedAt: "2026-08-15T12:00:00.000Z",
      windows: [],
    });
  });

  it("keeps omitted Codex windows and fields when sparse runtime updates arrive", () => {
    const initial = availabilityFromRuntimeEvent(codexRateLimitEvent)!;
    const primaryOnly = availabilityFromRuntimeEvent({
      ...codexRateLimitEvent,
      createdAt: "2026-08-15T12:01:00.000Z",
      payload: {
        rateLimits: {
          rateLimits: {
            primary: { usedPercent: 55 },
          },
        },
      },
    } satisfies ProviderRuntimeEvent)!;
    const metadataOnly = availabilityFromRuntimeEvent({
      ...codexRateLimitEvent,
      createdAt: "2026-08-15T12:02:00.000Z",
      payload: { rateLimits: { rateLimits: {} } },
    } satisfies ProviderRuntimeEvent)!;

    expect(mergeProviderAvailability(initial, primaryOnly).windows).toMatchObject([
      {
        kind: "primary",
        usedPercent: 55,
        resetsAt: initial.windows[0]!.resetsAt,
        windowDurationMins: 300,
      },
      { kind: "secondary", usedPercent: 100 },
    ]);
    expect(mergeProviderAvailability(initial, metadataOnly)).toMatchObject({
      status: "limited",
      windows: initial.windows,
    });
  });

  it("keeps cold native providers unknown and expires old percentages", () => {
    expect(availabilityAt(undefined, ProviderDriverKind.make("codex"), 0)).toEqual({
      status: "unknown",
      source: "codex_app_server",
      windows: [],
    });
    const snapshot = availabilityFromRuntimeEvent(codexRateLimitEvent)!;
    expect(
      availabilityAt(
        { availability: snapshot, receivedAtMs: 0 },
        ProviderDriverKind.make("codex"),
        15 * 60 * 1_000 + 1,
      ),
    ).toEqual({
      status: "unknown",
      source: "codex_app_server",
      observedAt: snapshot.observedAt,
      windows: [],
    });
    expect(
      availabilityAt(
        { availability: snapshot, receivedAtMs: 0 },
        ProviderDriverKind.make("claudeAgent"),
        0,
      ),
    ).toEqual({
      status: "unknown",
      source: "claude_agent_sdk",
      windows: [],
    });
  });

  it("keeps a Claude CLI snapshot instead of discarding it as a foreign source", () => {
    expect(
      availabilityAt(
        { availability: claudeCliSnapshot, receivedAtMs: 0 },
        ProviderDriverKind.make("claudeAgent"),
        60_000,
      ),
    ).toEqual(claudeCliSnapshot);
    expect(
      availabilityAt(
        { availability: claudeCliSnapshot, receivedAtMs: 0 },
        ProviderDriverKind.make("codex"),
        60_000,
      ),
    ).toEqual({ status: "unknown", source: "codex_app_server", windows: [] });
  });

  it("keeps the source, observation time and account when a snapshot ages out", () => {
    expect(
      availabilityAt(
        { availability: claudeCliSnapshot, receivedAtMs: 0 },
        ProviderDriverKind.make("claudeAgent"),
        15 * 60 * 1_000 + 1,
      ),
    ).toEqual({
      status: "unknown",
      source: "claude_cli_usage",
      observedAt: "2026-08-17T20:45:00.000Z",
      account: claudeCliSnapshot.account,
      windows: [],
    });
  });

  it("forgets an account snapshot when its configured adapter is rebuilt", () => {
    const instanceId = ProviderInstanceId.make("codex-personal");
    const oldAdapter = {};
    const replacementAdapter = {};
    const snapshot = availabilityFromRuntimeEvent(codexRateLimitEvent)!;
    const retained = clearAvailabilityForReconciledAdapters(
      new Map([[instanceId, { availability: snapshot, receivedAtMs: 0 }]]),
      new Map([[instanceId, oldAdapter]]),
      new Map([[instanceId, replacementAdapter]]),
    );
    expect(retained.get(instanceId)).toBeUndefined();
  });
});

describe("claimAvailabilityRefresh", () => {
  it("lets exactly one of two simultaneous callers run the provider CLI", () => {
    const [firstClaim, afterFirst] = claimAvailabilityRefresh(
      new Map<ProviderInstanceId, number>(),
      claudeInstanceId,
      1_000,
    );
    const [secondClaim, afterSecond] = claimAvailabilityRefresh(
      afterFirst,
      claudeInstanceId,
      1_000,
    );
    expect([firstClaim, secondClaim]).toEqual([true, false]);
    expect(afterFirst.get(claudeInstanceId)).toBe(1_000);
    expect(afterSecond.get(claudeInstanceId)).toBe(1_000);
  });

  it("allows the next refresh once the cooldown has passed", () => {
    const entries = new Map([[claudeInstanceId, 1_000]]);
    expect(claimAvailabilityRefresh(entries, claudeInstanceId, 30_999)[0]).toBe(false);
    const [claimed, next] = claimAvailabilityRefresh(entries, claudeInstanceId, 31_000);
    expect(claimed).toBe(true);
    expect(next.get(claudeInstanceId)).toBe(31_000);
    // The caller's map is never mutated in place.
    expect(entries.get(claudeInstanceId)).toBe(1_000);
  });

  it("does not hold a cooldown for an instance that no longer exists", () => {
    const removedInstanceId = ProviderInstanceId.make("claude-old");
    const adapter = {};
    const retained = retainStateForReconciledAdapters(
      new Map([
        [claudeInstanceId, 1_000],
        [removedInstanceId, 1_000],
      ]),
      new Map([[claudeInstanceId, adapter]]),
      new Map([[claudeInstanceId, adapter]]),
    );
    expect([...retained.entries()]).toEqual([[claudeInstanceId, 1_000]]);
  });
});
