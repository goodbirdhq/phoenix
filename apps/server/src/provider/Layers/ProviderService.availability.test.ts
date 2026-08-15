import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { availabilityFromRuntimeEvent } from "./ProviderService.ts";

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
});
