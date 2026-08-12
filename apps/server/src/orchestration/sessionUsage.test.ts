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
  it("maps inputTokens/outputTokens to the last-turn fields and totalTokens to totalProcessedTokens", () => {
    expect(
      tokensFromContextWindowPayload({
        inputTokens: 100,
        outputTokens: 50,
        usedTokens: 900,
        totalProcessedTokens: 5000,
      }),
    ).toEqual({ lastTurnInputTokens: 100, lastTurnOutputTokens: 50, totalTokens: 5000 });
  });

  it("omits totalTokens rather than falling back to usedTokens (context-window occupancy) when totalProcessedTokens is absent", () => {
    // usedTokens is bounded by the context window and drops after
    // compaction; it is not a stand-in for a cumulative spend number, so a
    // payload that only carries usedTokens must not populate totalTokens.
    expect(tokensFromContextWindowPayload({ usedTokens: 900 })).toEqual({
      lastTurnInputTokens: null,
      lastTurnOutputTokens: null,
      totalTokens: null,
    });
  });

  it("returns all nulls for a payload with no usable numeric fields", () => {
    expect(tokensFromContextWindowPayload(null)).toEqual({
      lastTurnInputTokens: null,
      lastTurnOutputTokens: null,
      totalTokens: null,
    });
    expect(tokensFromContextWindowPayload("not an object")).toEqual({
      lastTurnInputTokens: null,
      lastTurnOutputTokens: null,
      totalTokens: null,
    });
    expect(tokensFromContextWindowPayload({ inputTokens: "not a number" })).toEqual({
      lastTurnInputTokens: null,
      lastTurnOutputTokens: null,
      totalTokens: null,
    });
  });

  it("rejects negative and non-finite values", () => {
    expect(
      tokensFromContextWindowPayload({
        inputTokens: -5,
        outputTokens: Number.POSITIVE_INFINITY,
        totalProcessedTokens: Number.NaN,
      }),
    ).toEqual({ lastTurnInputTokens: null, lastTurnOutputTokens: null, totalTokens: null });
  });
});

describe("elapsedMsSince", () => {
  it("returns the wall-clock gap between createdAt and now", () => {
    expect(elapsedMsSince("2026-08-12T00:00:00.000Z", "2026-08-12T00:00:45.000Z")).toBe(45_000);
  });

  it("clamps to zero rather than going negative", () => {
    expect(elapsedMsSince("2026-08-12T00:00:45.000Z", "2026-08-12T00:00:00.000Z")).toBe(0);
  });

  it("degrades to zero instead of NaN when a timestamp fails to parse", () => {
    expect(elapsedMsSince("not a timestamp", "2026-08-12T00:00:45.000Z")).toBe(0);
    expect(elapsedMsSince("2026-08-12T00:00:00.000Z", "not a timestamp")).toBe(0);
    expect(elapsedMsSince("not a timestamp", "also not a timestamp")).toBe(0);
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

  it("returns null instead of NaN when a timestamp fails to parse", () => {
    expect(
      lastTurnDurationMsFromTurn({ startedAt: "not a timestamp", completedAt: "also not one" }),
    ).toBeNull();
  });
});

describe("buildSessionUsageSnapshot", () => {
  it("omits every field but elapsedMs when nothing else is known", () => {
    expect(
      buildSessionUsageSnapshot({
        tokens: { lastTurnInputTokens: null, lastTurnOutputTokens: null, totalTokens: null },
        turnCount: null,
        elapsedMs: 1_000,
        lastTurnDurationMs: null,
      }),
    ).toEqual({ elapsedMs: 1_000 });
  });

  it("includes every field that is known", () => {
    expect(
      buildSessionUsageSnapshot({
        tokens: { lastTurnInputTokens: 10, lastTurnOutputTokens: 20, totalTokens: 30 },
        turnCount: 4,
        elapsedMs: 5_000,
        lastTurnDurationMs: 2_000,
      }),
    ).toEqual({
      lastTurnInputTokens: 10,
      lastTurnOutputTokens: 20,
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
            Effect.succeed(
              Option.some({ inputTokens: 10, outputTokens: 5, totalProcessedTokens: 15 }),
            ),
          getThreadTurnCount: () => Effect.succeed(2),
        },
        {
          threadId: "thread-1" as never,
          createdAt: "2026-08-12T00:00:00.000Z",
          latestTurn: { startedAt: "2026-08-12T00:00:00.000Z", completedAt: null },
        },
      );

      expect(snapshot.lastTurnInputTokens).toBe(10);
      expect(snapshot.lastTurnOutputTokens).toBe(5);
      expect(snapshot.totalTokens).toBe(15);
      expect(snapshot.turnCount).toBe(2);
      expect(snapshot.lastTurnDurationMs).toBeUndefined();
      expect(snapshot.elapsedMs).toBeGreaterThanOrEqual(0);
    }),
  );

  it.effect(
    "omits totalTokens when the activity only reports context-window occupancy, not a cumulative counter",
    () =>
      Effect.gen(function* () {
        const snapshot = yield* resolveSessionUsageSnapshot(
          {
            getLatestUsageActivity: () =>
              Effect.succeed(Option.some({ inputTokens: 10, outputTokens: 5, usedTokens: 900 })),
            getThreadTurnCount: () => Effect.succeed(1),
          },
          {
            threadId: "thread-1" as never,
            createdAt: "2026-08-12T00:00:00.000Z",
            latestTurn: null,
          },
        );

        expect(snapshot.lastTurnInputTokens).toBe(10);
        expect(snapshot.lastTurnOutputTokens).toBe(5);
        expect(snapshot.totalTokens).toBeUndefined();
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
