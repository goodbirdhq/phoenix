import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { salesDeviceBlockedReason } from "./salesDeviceGuard";

const ENGINE = "https://engine.example";

const primary = (salesBaseUrl: string | null) => ({
  target: new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("primary"),
    label: "This machine",
    httpBaseUrl: "http://localhost:3874",
    wsBaseUrl: "ws://localhost:3874",
  }),
  salesBaseUrl,
});

const bearer = (connectionId: string, salesBaseUrl: string | null) => ({
  target: new BearerConnectionTarget({
    environmentId: EnvironmentId.make(connectionId),
    connectionId,
    label: connectionId,
  }),
  salesBaseUrl,
});

describe("salesDeviceBlockedReason", () => {
  it("blocks a web page served by a Phoenix server, whichever environment reads the engine", () => {
    // The engine is read through a remote environment, but this page's code came from a
    // Phoenix server all the same.
    expect(
      salesDeviceBlockedReason({
        isDesktop: false,
        engine: ENGINE,
        environments: [primary(""), bearer("remote", ENGINE)],
      }),
    ).not.toBeNull();
  });

  it("lets the hosted web app, which has no primary, hold a key", () => {
    expect(
      salesDeviceBlockedReason({
        isDesktop: false,
        engine: ENGINE,
        environments: [bearer("remote", ENGINE)],
      }),
    ).toBeNull();
  });

  it("blocks desktop when one of its local backends reads this engine", () => {
    for (const local of [
      primary(`${ENGINE}/`),
      bearer("local:wsl:Ubuntu", "HTTPS://ENGINE.example"),
    ]) {
      expect(
        salesDeviceBlockedReason({
          isDesktop: true,
          engine: ENGINE,
          environments: [local, bearer("remote", ENGINE)],
        }),
      ).not.toBeNull();
    }
  });

  it("blocks desktop while a local backend's settings are unknown", () => {
    expect(
      salesDeviceBlockedReason({ isDesktop: true, engine: ENGINE, environments: [primary(null)] }),
    ).not.toBeNull();
  });

  it("lets desktop hold a key for an engine only remote environments read", () => {
    expect(
      salesDeviceBlockedReason({
        isDesktop: true,
        engine: ENGINE,
        environments: [primary("https://other-engine.example"), bearer("remote", ENGINE)],
      }),
    ).toBeNull();
  });
});
