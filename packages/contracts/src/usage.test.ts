import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { narrowUsageSummary, UsageSummary } from "./usage.ts";

const V4UsageSummary = Schema.Struct({
  contractVersion: Schema.Number,
  buckets: Schema.Array(Schema.Struct({ provider: Schema.Literals(["claude", "codex"]) })),
  sources: Schema.Array(
    Schema.Struct({
      fingerprint: Schema.Struct({ provider: Schema.Literals(["claude", "codex"]) }),
    }),
  ),
});
const decodeV4UsageSummary = Schema.decodeUnknownSync(V4UsageSummary);
const decodeRequestAsV4Server = Schema.decodeUnknownSync(
  Schema.Struct({
    sinceDay: Schema.String,
    untilDay: Schema.String,
    timeZone: Schema.String,
    resolution: Schema.optional(Schema.Literals(["day", "hour"])),
    sinceTime: Schema.optional(Schema.String),
    untilTime: Schema.optional(Schema.String),
  }),
);

const summary = Schema.decodeUnknownSync(UsageSummary)({
  contractVersion: 5,
  readAt: "2026-08-22T00:00:00.000Z",
  timeZone: "UTC",
  sinceDay: "2026-08-22",
  untilDay: "2026-08-22",
  buckets: [
    {
      day: "2026-08-22",
      provider: "claude",
      sourceId: "claude-source",
      model: "claude-fable-5",
      totals: {
        uncachedInputTokens: 1,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
      },
      costUsd: 0,
      cacheSavingsUsd: 0,
      costSource: "unpriced",
      records: 1,
      unpricedRecords: 1,
      sessions: 1,
    },
    {
      day: "2026-08-22",
      provider: "opencode",
      sourceId: "opencode-source",
      model: "openai/gpt-5",
      totals: {
        uncachedInputTokens: 1,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
      },
      costUsd: 0,
      cacheSavingsUsd: 0,
      costSource: "providerReported",
      records: 1,
      unpricedRecords: 0,
      sessions: 1,
    },
  ],
  sources: [
    {
      id: "claude-source",
      fingerprint: {
        hostId: "host",
        provider: "claude",
        resolvedHomePath: "/home/.claude",
        volumeId: "1:1",
      },
      status: "ok",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
    },
    {
      id: "opencode-source",
      fingerprint: {
        hostId: "host",
        provider: "opencode",
        resolvedHomePath: "/data/opencode.db",
        volumeId: "1:2",
      },
      status: "ok",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
    },
  ],
  pricing: {
    status: "unavailable",
    source: "https://example.test/rates.json",
    fetchedAt: null,
    knownModels: 0,
  },
  scanDurationMs: 1,
});

describe("narrowUsageSummary", () => {
  it("answers an omitted-version caller in the deployed v4 vocabulary", () => {
    const narrowed = narrowUsageSummary(summary, undefined);

    expect(() => decodeV4UsageSummary(narrowed)).not.toThrow();
    expect(narrowed.contractVersion).toBe(4);
    expect(narrowed.buckets.map((bucket) => bucket.provider)).toEqual(["claude"]);
    expect(narrowed.sources.map((source) => source.fingerprint.provider)).toEqual(["claude"]);
  });

  it("leaves the current vocabulary unchanged", () => {
    expect(narrowUsageSummary(summary, 5)).toBe(summary);
  });

  it("keeps current requests decodable by a v4 server", () => {
    expect(() =>
      decodeRequestAsV4Server({
        sinceDay: "2026-08-22",
        untilDay: "2026-08-22",
        timeZone: "UTC",
        contractVersion: 5,
      }),
    ).not.toThrow();
  });
});
