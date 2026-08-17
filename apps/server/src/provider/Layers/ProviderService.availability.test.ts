import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderAvailability,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  availabilityAt,
  availabilityFromRuntimeEvent,
  cacheProviderAvailability,
  claimAvailabilityRefresh,
  clearAvailabilityForReconciledAdapters,
  mergeProviderAvailability,
  retainStateForReconciledAdapters,
  unknownRefreshAvailability,
} from "./ProviderService.ts";

const claudeInstanceId = ProviderInstanceId.make("claude-work");
/** When a refresh that produced nothing ran. */
const failedAt = "2026-08-17T20:51:00.000Z";

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

const emptySdkUpdate = availabilityFromRuntimeEvent({
  ...codexRateLimitEvent,
  provider: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: claudeInstanceId,
  createdAt: "2026-08-17T20:50:00.000Z",
} satisfies ProviderRuntimeEvent)!;

describe("mergeProviderAvailability window identity", () => {
  it("keeps two pools of one kind apart when they carry different scopes", () => {
    const previous = {
      status: "available",
      source: "codex_app_server",
      observedAt: "2026-08-17T20:45:00.000Z",
      windows: [
        { kind: "weekly", scope: "all-models", usedPercent: 40, windowDurationMins: 10_080 },
        { kind: "weekly", scope: "fable", usedPercent: 12 },
      ],
    } satisfies ProviderAvailability;
    const incoming = {
      ...previous,
      observedAt: "2026-08-17T20:50:00.000Z",
      windows: [{ kind: "weekly", scope: "fable", usedPercent: 15 }],
    } satisfies ProviderAvailability;

    expect(mergeProviderAvailability(previous, incoming).windows).toEqual([
      { kind: "weekly", scope: "all-models", usedPercent: 40, windowDurationMins: 10_080 },
      { kind: "weekly", scope: "fable", usedPercent: 15 },
    ]);
  });
});

describe("cacheProviderAvailability", () => {
  it("keeps a Claude /usage reading when an empty SDK update arrives", () => {
    expect(emptySdkUpdate.windows).toEqual([]);
    expect(mergeProviderAvailability(claudeCliSnapshot, emptySdkUpdate)).toEqual(claudeCliSnapshot);
  });

  it("does not let an empty SDK update pass a stale reading off as fresh", () => {
    const cached = { availability: claudeCliSnapshot, receivedAtMs: 1_000 };
    const next = cacheProviderAvailability(cached, emptySdkUpdate, 14 * 60 * 1_000);
    // Same entry, same age: the ping carried no reading, so it cannot renew one.
    expect(next).toBe(cached);
    expect(
      availabilityAt(next, ProviderDriverKind.make("claudeAgent"), 16 * 60 * 1_000).windows,
    ).toEqual([]);
  });

  it("takes an SDK snapshot that actually carries windows", () => {
    const sdkWithWindows = {
      ...emptySdkUpdate,
      status: "available",
      windows: [{ kind: "session", usedPercent: 10 }],
    } satisfies ProviderAvailability;
    const cached = { availability: claudeCliSnapshot, receivedAtMs: 1_000 };
    const next = cacheProviderAvailability(cached, sdkWithWindows, 5_000);
    expect(next).toEqual({ availability: sdkWithWindows, receivedAtMs: 5_000 });
  });

  it("advances freshness for a new /usage reading", () => {
    const cached = { availability: claudeCliSnapshot, receivedAtMs: 1_000 };
    const newer = {
      ...claudeCliSnapshot,
      observedAt: "2026-08-17T21:05:00.000Z",
      windows: [{ kind: "session", label: "Current session", usedPercent: 9 }],
    } satisfies ProviderAvailability;
    expect(cacheProviderAvailability(cached, newer, 5_000)).toEqual({
      availability: newer,
      receivedAtMs: 5_000,
    });
  });
});

describe("unknownRefreshAvailability", () => {
  it("names the channel the refresh actually ran on", () => {
    // A Claude refresh runs the CLI's `/usage` panel, so a failed one must not
    // report itself as a quiet Agent SDK.
    expect(unknownRefreshAvailability(ProviderDriverKind.make("claudeAgent"), failedAt)).toEqual({
      status: "unknown",
      source: "claude_cli_usage",
      observedAt: failedAt,
      windows: [],
    });
    expect(unknownRefreshAvailability(ProviderDriverKind.make("codex"), failedAt)).toEqual({
      status: "unknown",
      source: "codex_app_server",
      observedAt: failedAt,
      windows: [],
    });
    expect(unknownRefreshAvailability(ProviderDriverKind.make("opencode"), failedAt)).toEqual({
      status: "unknown",
      source: "unsupported",
      observedAt: failedAt,
      windows: [],
    });
  });

  it("says when the failed attempt happened", () => {
    // Without it a client cannot tell an instance that was just asked and had
    // nothing to say from one that has never been read at all.
    expect(
      unknownRefreshAvailability(ProviderDriverKind.make("claudeAgent"), failedAt).observedAt,
    ).toBe(failedAt);
  });

  it("stays a snapshot a Claude instance will present rather than discard", () => {
    const failed = unknownRefreshAvailability(ProviderDriverKind.make("claudeAgent"), failedAt);
    expect(
      availabilityAt(
        { availability: failed, receivedAtMs: 0 },
        ProviderDriverKind.make("claudeAgent"),
        0,
      ),
    ).toEqual(failed);
  });
});

describe("a refresh that came back with nothing", () => {
  const claudeAgent = ProviderDriverKind.make("claudeAgent");
  const failedRefresh = unknownRefreshAvailability(claudeAgent, failedAt);

  it("keeps the reading a person is looking at instead of blanking it", () => {
    const merged = mergeProviderAvailability(claudeCliSnapshot, failedRefresh);
    expect(merged.windows).toEqual(claudeCliSnapshot.windows);
    expect(merged.account).toEqual(claudeCliSnapshot.account);
    // The windows are still the ones read at 20:45, and they say so.
    expect(merged.observedAt).toBe(claudeCliSnapshot.observedAt);
  });

  it("marks the kept reading stale rather than passing it off as confirmed", () => {
    expect(mergeProviderAvailability(claudeCliSnapshot, failedRefresh).stale).toEqual({
      reason: "refresh_failed",
      attemptedAt: failedAt,
    });
  });

  it("calls a panel that rendered no rows empty, not failed", () => {
    // The CLI answered and named the account; it simply had no quota rows.
    const emptyPanel = {
      status: "unknown",
      source: "claude_cli_usage",
      observedAt: failedAt,
      account: claudeCliSnapshot.account,
      windows: [],
    } satisfies ProviderAvailability;
    expect(mergeProviderAvailability(claudeCliSnapshot, emptyPanel).stale).toEqual({
      reason: "refresh_empty",
      attemptedAt: failedAt,
    });
  });

  it("lets the kept reading expire on its original clock", () => {
    const cached = { availability: claudeCliSnapshot, receivedAtMs: 1_000 };
    const afterOneFailure = cacheProviderAvailability(cached, failedRefresh, 10 * 60 * 1_000);
    expect(afterOneFailure.receivedAtMs).toBe(1_000);
    // A run of failures cannot keep one old panel alive for ever.
    const afterTwo = cacheProviderAvailability(
      afterOneFailure,
      unknownRefreshAvailability(claudeAgent, "2026-08-17T20:56:00.000Z"),
      14 * 60 * 1_000,
    );
    expect(afterTwo.receivedAtMs).toBe(1_000);
    expect(availabilityAt(afterTwo, claudeAgent, 14 * 60 * 1_000).windows).toEqual(
      claudeCliSnapshot.windows,
    );
    // Fifteen minutes after it was *received*, not after the last attempt.
    expect(availabilityAt(afterTwo, claudeAgent, 1_000 + 15 * 60 * 1_000 + 1)).toEqual({
      status: "unknown",
      source: "claude_cli_usage",
      observedAt: claudeCliSnapshot.observedAt,
      account: claudeCliSnapshot.account,
      windows: [],
    });
  });

  it("gives way to a reading that names a different account", () => {
    // Whatever else happens, one account's bars are never shown under another's
    // name.
    const otherAccount = {
      status: "unknown",
      source: "claude_cli_usage",
      observedAt: failedAt,
      account: {
        id: "claude:org-2:someone-else@example.com",
        verification: "native_verified",
        displayName: "someone-else@example.com",
      },
      windows: [],
    } satisfies ProviderAvailability;
    expect(mergeProviderAvailability(claudeCliSnapshot, otherAccount)).toEqual(otherAccount);
    expect(
      cacheProviderAvailability(
        { availability: claudeCliSnapshot, receivedAtMs: 1 },
        otherAccount,
        5_000,
      ),
    ).toEqual({ availability: otherAccount, receivedAtMs: 5_000 });
  });

  it("is replaced outright by the next reading that carries windows", () => {
    const stale = mergeProviderAvailability(claudeCliSnapshot, failedRefresh);
    expect(stale.stale).toBeDefined();
    const recovered = {
      ...claudeCliSnapshot,
      observedAt: "2026-08-17T21:05:00.000Z",
      windows: [{ kind: "session", label: "Current session", usedPercent: 9 }],
    } satisfies ProviderAvailability;
    const merged = mergeProviderAvailability(stale, recovered);
    expect(merged).toEqual(recovered);
    expect(merged.stale).toBe(undefined);
  });

  it("does not mark a passive SDK ping as a failed refresh", () => {
    // Nothing was asked of the SDK, so nothing failed.
    expect(mergeProviderAvailability(claudeCliSnapshot, emptySdkUpdate)).toBe(claudeCliSnapshot);
  });
});
