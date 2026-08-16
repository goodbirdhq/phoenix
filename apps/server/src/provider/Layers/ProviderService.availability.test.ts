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
  mergeProviderAvailability,
} from "./ProviderService.ts";

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

  it("keeps the other Codex window when sparse runtime updates arrive", () => {
    const initial = availabilityFromRuntimeEvent(codexRateLimitEvent)!;
    const primaryOnly = availabilityFromRuntimeEvent({
      ...codexRateLimitEvent,
      createdAt: "2026-08-15T12:01:00.000Z",
      payload: {
        rateLimits: {
          rateLimits: {
            primary: { usedPercent: 55, resetsAt: 1_786_272_000, windowDurationMins: 300 },
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
      { kind: "primary", usedPercent: 55 },
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
  });
});
