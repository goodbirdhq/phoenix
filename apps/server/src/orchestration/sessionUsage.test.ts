import { PersistenceSqlError } from "../persistence/Errors.ts";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  buildSessionUsageSnapshot,
  elapsedMsSince,
  lastTurnDurationMsFromTurn,
  resolveSessionUsageSnapshot,
  tokensFromContextWindowPayload,
} from "./sessionUsage.ts";

describe("tokensFromContextWindowPayload", () => {
  it("extracts input/output tokens and prefers totalProcessedTokens for totalTokens", () => {
    expect(
      tokensFromContextWindowPayload({
        inputTokens: 100,
        outputTokens: 50,
        usedTokens: 900,
        totalProcessedTokens: 5000,
      }),
    ).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 5000 });
  });

  it("falls back to usedTokens (context-fill) when totalProcessedTokens is absent", () => {
    expect(tokensFromContextWindowPayload({ usedTokens: 900 })).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: 900,
    });
  });

  it("returns all nulls for a payload with no usable numeric fields", () => {
    expect(tokensFromContextWindowPayload(null)).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
    expect(tokensFromContextWindowPayload("not an object")).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
    expect(tokensFromContextWindowPayload({ inputTokens: "not a number" })).toEqual({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
    });
  });

  it("rejects negative and non-finite values", () => {
    expect(
      tokensFromContextWindowPayload({ inputTokens: -5, outputTokens: Number.POSITIVE_INFINITY }),
    ).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
  });
});

describe("elapsedMsSince", () => {
  it("returns the wall-clock gap between createdAt and now", () => {
    expect(elapsedMsSince("2026-08-12T00:00:00.000Z", "2026-08-12T00:00:45.000Z")).toBe(45_000);
  });

  it("clamps to zero rather than going negative", () => {
    expect(elapsedMsSince("2026-08-12T00:00:45.000Z", "2026-08-12T00:00:00.000Z")).toBe(0);
  });
});

describe("lastTurnDurationMsFromTurn", () => {
  it("computes the gap between startedAt and completedAt", () => {
    expect(
      lastTurnDurationMsFromTurn({
        startedAt: "2026-08-12T00:00:00.000Z",
        completedAt: "2026-08-12T00:00:12.000Z",
      }),
    ).toBe(12_000);
  });

  it("returns null when the turn has not completed, started, or does not exist", () => {
    expect(lastTurnDurationMsFromTurn(null)).toBeNull();
    expect(lastTurnDurationMsFromTurn({ startedAt: null, completedAt: null })).toBeNull();
    expect(
      lastTurnDurationMsFromTurn({ startedAt: "2026-08-12T00:00:00.000Z", completedAt: null }),
    ).toBeNull();
  });
});

describe("buildSessionUsageSnapshot", () => {
  it("omits every field but elapsedMs when nothing else is known", () => {
    expect(
      buildSessionUsageSnapshot({
        tokens: { inputTokens: null, outputTokens: null, totalTokens: null },
        turnCount: null,
        elapsedMs: 1_000,
        lastTurnDurationMs: null,
      }),
    ).toEqual({ elapsedMs: 1_000 });
  });

  it("includes every field that is known", () => {
    expect(
      buildSessionUsageSnapshot({
        tokens: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        turnCount: 4,
        elapsedMs: 5_000,
        lastTurnDurationMs: 2_000,
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      turnCount: 4,
      elapsedMs: 5_000,
      lastTurnDurationMs: 2_000,
    });
  });
});

describe("resolveSessionUsageSnapshot", () => {
  it.effect("assembles a snapshot from both bounded reads", () =>
    Effect.gen(function* () {
      const snapshot = yield* resolveSessionUsageSnapshot(
        {
          getLatestUsageActivity: () =>
            Effect.succeed(Option.some({ inputTokens: 10, outputTokens: 5, usedTokens: 15 })),
          getThreadTurnCount: () => Effect.succeed(2),
        },
        {
          threadId: "thread-1" as never,
          createdAt: "2026-08-12T00:00:00.000Z",
          latestTurn: { startedAt: "2026-08-12T00:00:00.000Z", completedAt: null },
        },
      );

      expect(snapshot.inputTokens).toBe(10);
      expect(snapshot.outputTokens).toBe(5);
      expect(snapshot.totalTokens).toBe(15);
      expect(snapshot.turnCount).toBe(2);
      expect(snapshot.lastTurnDurationMs).toBeUndefined();
      expect(snapshot.elapsedMs).toBeGreaterThanOrEqual(0);
    }),
  );

  it.effect("degrades to elapsedMs only when both bounded reads fail", () =>
    Effect.gen(function* () {
      const failure = new PersistenceSqlError({ operation: "test", detail: "unavailable" });
      const snapshot = yield* resolveSessionUsageSnapshot(
        {
          getLatestUsageActivity: () => Effect.fail(failure),
          getThreadTurnCount: () => Effect.fail(failure),
        },
        {
          threadId: "thread-1" as never,
          createdAt: "2026-08-12T00:00:00.000Z",
          latestTurn: null,
        },
      );

      expect(snapshot).toEqual({ elapsedMs: expect.any(Number) });
    }),
  );
});
