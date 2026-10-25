import { describe, expect, it } from "vite-plus/test";

import { resolvePhoenixCloudOwnershipView } from "./PhoenixCloudOwnershipGate.logic";

describe("installation ownership gate", () => {
  it("requires confirmed ownership before normal use", () => {
    expect(
      resolvePhoenixCloudOwnershipView({ state: undefined, error: null, locallySignedOut: false }),
    ).toBe("loading");
    expect(
      resolvePhoenixCloudOwnershipView({
        state: "signed-out",
        error: null,
        locallySignedOut: false,
      }),
    ).toBe("link");
    expect(
      resolvePhoenixCloudOwnershipView({
        state: "signed-in",
        error: null,
        locallySignedOut: false,
      }),
    ).toBe("app");
  });
  it("keeps temporary verification failure distinct from missing ownership", () => {
    expect(
      resolvePhoenixCloudOwnershipView({
        state: "unavailable",
        error: null,
        locallySignedOut: false,
      }),
    ).toBe("unavailable");
    for (const state of [undefined, "signed-in", "signed-out"]) {
      expect(
        resolvePhoenixCloudOwnershipView({
          state,
          error: "Connection lost",
          locallySignedOut: false,
        }),
      ).toBe("unavailable");
    }
  });
  it("never reopens from stale signed-in data after local logout", () => {
    for (const state of [undefined, "signed-in", "signed-out", "unavailable"]) {
      expect(resolvePhoenixCloudOwnershipView({ state, error: null, locallySignedOut: true })).toBe(
        "link",
      );
      expect(
        resolvePhoenixCloudOwnershipView({
          state,
          error: "Request failed",
          locallySignedOut: true,
        }),
      ).toBe("link");
    }
  });
});
