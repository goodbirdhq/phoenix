import { describe, expect, it } from "vite-plus/test";

import { reconcilePhoenixCloudLogout } from "./phoenixCloudLogout";
import { resolvePhoenixCloudOwnershipView } from "../components/PhoenixCloudOwnershipGate.logic";

describe("Phoenix Cloud logout reconciliation", () => {
  it("waits for settled logout and confirmed signed-out before following an external relink", () => {
    const pending = { signedOut: true, pending: true, error: null };
    expect(reconcilePhoenixCloudLogout(pending, { state: "signed-in", confirmed: true })).toBe(
      pending,
    );
    expect(reconcilePhoenixCloudLogout(pending, { state: "signed-out", confirmed: true })).toBe(
      pending,
    );

    const settled = { ...pending, pending: false };
    expect(reconcilePhoenixCloudLogout(settled, { state: "signed-in", confirmed: true })).toBe(
      settled,
    );
    expect(reconcilePhoenixCloudLogout(settled, { state: "signed-out", confirmed: false })).toBe(
      settled,
    );
    expect(reconcilePhoenixCloudLogout(settled, { state: "unavailable", confirmed: true })).toBe(
      settled,
    );
    expect(
      resolvePhoenixCloudOwnershipView({
        state: "signed-in",
        error: null,
        locallySignedOut: settled.signedOut,
      }),
    ).toBe("link");

    const acknowledged = reconcilePhoenixCloudLogout(settled, {
      state: "signed-out",
      confirmed: true,
    });
    expect(
      resolvePhoenixCloudOwnershipView({
        state: "signed-out",
        error: null,
        locallySignedOut: acknowledged.signedOut,
      }),
    ).toBe("link");
    expect(
      resolvePhoenixCloudOwnershipView({
        state: "signed-in",
        error: null,
        locallySignedOut: acknowledged.signedOut,
      }),
    ).toBe("app");
  });

  it("retains failed revocation recovery while accepting the persisted local signout", () => {
    const failed = { signedOut: true, pending: false, error: "Cloud unavailable" };
    expect(reconcilePhoenixCloudLogout(failed, { state: "signed-in", confirmed: true })).toBe(
      failed,
    );
    const signedOut = reconcilePhoenixCloudLogout(failed, { state: "signed-out", confirmed: true });
    expect(signedOut).toEqual({ ...failed, signedOut: false });
    const relinked = reconcilePhoenixCloudLogout(signedOut, {
      state: "signed-in",
      confirmed: true,
    });
    expect(relinked).toEqual({ signedOut: false, pending: false, error: null });
  });
});
