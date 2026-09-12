import { describe, expect, it } from "vite-plus/test";

import { createDevProxyEntries, isDevProxiedPath } from "./devProxy";

describe("single-origin development proxy", () => {
  it("forwards HTTP and both application and device WebSocket paths to the backend", () => {
    const target = "http://localhost:4317";
    const entries = createDevProxyEntries(target)!;
    for (const path of ["/api", "/ws"]) {
      expect(entries[path]).toEqual({ target, changeOrigin: true, ws: true });
    }
    for (const path of ["/oauth", "/.well-known"]) {
      expect(entries[path]).toEqual({ target, changeOrigin: true });
    }
    expect(isDevProxiedPath("/api/devices/stream")).toBe(true);
    expect(isDevProxiedPath("/apiary")).toBe(false);
  });

  it("does not configure forwarding without a backend target", () => {
    expect(createDevProxyEntries(undefined)).toBeUndefined();
  });
});
