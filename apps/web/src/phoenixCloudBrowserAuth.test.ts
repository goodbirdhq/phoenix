import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  readPhoenixCloudCallback,
  safePhoenixCloudReturnRoute,
  savePhoenixCloudBrowserAttempt,
  takePhoenixCloudBrowserAttempt,
  preparePhoenixCloudBrowserReturn,
  pendingPhoenixCloudBrowserReturn,
  clearPhoenixCloudBrowserReturn,
} from "./phoenixCloudBrowserAuth";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("Phoenix Cloud browser return", () => {
  it("scrubs callback parameters before routing and keeps the response only in memory", () => {
    const store = storage();
    savePhoenixCloudBrowserAttempt(store, "state", {
      environmentId: EnvironmentId.make("remote"),
      route: "/remote/original",
    });
    const browser = {
      location: new URL(
        "https://hosted.example/cloud/callback?state=state&code=one-time&iss=https%3A%2F%2Fcloud.example%2Fapi%2Fauth#discard",
      ),
      sessionStorage: store,
      history: {
        state: null,
        replaceState: (_state: unknown, _unused: string, url: string) => {
          browser.location = new URL(url, browser.location);
        },
      },
    };
    vi.stubGlobal("window", browser);
    try {
      preparePhoenixCloudBrowserReturn();
      expect(browser.location.href).toBe("https://hosted.example/cloud/callback");
      expect(pendingPhoenixCloudBrowserReturn()?.attempt).toEqual({
        environmentId: "remote",
        route: "/remote/original",
      });
      expect(pendingPhoenixCloudBrowserReturn()?.callback.code).toBe("one-time");
      expect(takePhoenixCloudBrowserAttempt(store, "state")).toBeNull();
      preparePhoenixCloudBrowserReturn();
      expect(pendingPhoenixCloudBrowserReturn()).toBeNull();
    } finally {
      clearPhoenixCloudBrowserReturn();
      vi.unstubAllGlobals();
    }
  });

  it("pins each OAuth state to its initiating installation and original route once", () => {
    const store = storage();
    const first = {
      environmentId: EnvironmentId.make("primary"),
      route: "/primary/thread?tab=diff#file",
    };
    const remote = {
      environmentId: EnvironmentId.make("remote"),
      route: "/settings/connections?machine=remote",
    };
    savePhoenixCloudBrowserAttempt(store, "first-state", first);
    savePhoenixCloudBrowserAttempt(store, "remote-state", remote);
    expect(takePhoenixCloudBrowserAttempt(store, "unknown-state")).toBeNull();
    expect(takePhoenixCloudBrowserAttempt(store, "remote-state")).toEqual(remote);
    expect(takePhoenixCloudBrowserAttempt(store, "remote-state")).toBeNull();
    expect(takePhoenixCloudBrowserAttempt(store, "first-state")).toEqual(first);
  });

  it("accepts code and denial callbacks only on the dedicated path with one issuer and state", () => {
    expect(
      readPhoenixCloudCallback(
        new URL(
          "https://ui.example/cloud/callback?state=s&code=c&iss=https%3A%2F%2Fcloud.example%2Fapi%2Fauth",
        ),
      ),
    ).toEqual({
      state: "s",
      code: "c",
      iss: "https://cloud.example/api/auth",
      returnUrl: "https://ui.example/cloud/callback",
    });
    expect(
      readPhoenixCloudCallback(
        new URL("https://ui.example/cloud/callback?state=s&error=access_denied&iss=issuer"),
      )?.error,
    ).toBe("access_denied");
    for (const query of [
      "state=s&state=other&code=c&iss=i",
      "state=s&code=c&error=denied&iss=i",
      "state=s&code=c",
      "state=s&code=c&iss=i&iss=j",
    ]) {
      expect(
        readPhoenixCloudCallback(new URL(`https://ui.example/cloud/callback?${query}`)),
      ).toBeNull();
    }
    expect(
      readPhoenixCloudCallback(new URL("https://ui.example/settings?state=s&code=c&iss=i")),
    ).toBeNull();
  });

  it("restores internal routes and rejects external, callback, and ambiguous destinations", () => {
    expect(safePhoenixCloudReturnRoute("/remote/thread?tab=diff#file")).toBe(
      "/remote/thread?tab=diff#file",
    );
    for (const value of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/cloud/callback?code=c",
      "javascript:alert(1)",
      "/\n/evil.example",
    ]) {
      expect(safePhoenixCloudReturnRoute(value)).toBe("/");
    }
  });
});
