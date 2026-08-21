import { describe, expect, it } from "vite-plus/test";

import type {
  ProviderAvailability,
  ProviderInstanceConfig,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { failoverCandidates, remainingScore } from "./LimitFailoverReactor.ts";

const instance = (
  driver: string,
  overrides: Record<string, unknown> = {},
): ProviderInstanceConfig =>
  ({ driver, config: {}, failoverGroup: "pool", ...overrides }) as ProviderInstanceConfig;

const origin = "origin" as ProviderInstanceId;
const select = (instances: Record<string, ProviderInstanceConfig>) =>
  failoverCandidates(instances, { originInstanceId: origin, group: "pool" }).map(([id]) => id);

describe("failoverCandidates", () => {
  it("never fails a thread back onto the limited instance", () => {
    expect(select({ origin: instance("codex"), other: instance("codex") })).toEqual(["other"]);
  });

  it("only considers members of the same failover group", () => {
    expect(
      select({
        origin: instance("codex"),
        sameGroup: instance("codex"),
        otherGroup: instance("codex", { failoverGroup: "elsewhere" }),
        ungrouped: instance("codex", { failoverGroup: undefined }),
      }),
    ).toEqual(["sameGroup"]);
  });

  it("skips an instance the user explicitly disabled", () => {
    expect(
      select({ origin: instance("codex"), off: instance("codex", { enabled: false }) }),
    ).toEqual([]);
  });

  // Grok, Cursor, and OpenCode are off until a user opts in, and carry no
  // explicit flag until then. A bare `enabled !== false` would treat that
  // default-off state as eligible and hand the thread to an instance the
  // server never probed.
  it("skips a default-off driver that was never enabled", () => {
    expect(select({ origin: instance("codex"), grok: instance("grok") })).toEqual([]);
  });

  it("accepts a default-off driver once it is enabled", () => {
    expect(
      select({ origin: instance("codex"), grok: instance("grok", { enabled: true }) }),
    ).toEqual(["grok"]);
  });
});

describe("remainingScore", () => {
  it("does not rank an unconfirmed reading from retained stale windows", () => {
    const availability = {
      status: "unknown",
      source: "codex_app_server",
      windows: [{ kind: "session", usedPercent: 10 }],
    } as ProviderAvailability;

    expect(remainingScore(availability)).toBe(0);
  });
});
