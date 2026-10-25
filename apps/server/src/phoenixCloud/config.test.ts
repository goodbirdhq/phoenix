import { describe, expect, it } from "vite-plus/test";

import { CloudOriginError, normalizeCloudOrigin } from "./config.ts";

describe("Phoenix Cloud origin", () => {
  it("requires an explicit origin", () => {
    expect(normalizeCloudOrigin(undefined)).toMatchObject({ reason: "missing" });
    expect(normalizeCloudOrigin("  ")).toMatchObject({ reason: "missing" });
  });

  it("normalizes HTTPS origins", () => {
    expect(normalizeCloudOrigin(" https://cloud.example.test:443/ ")).toBe(
      "https://cloud.example.test",
    );
  });

  it("allows development HTTP only with an explicit opt-in", () => {
    const origin = "http://agents.taildcab14.ts.net:3100";
    expect(normalizeCloudOrigin(origin)).toMatchObject({ reason: "insecure" });
    expect(normalizeCloudOrigin(origin, true)).toBe(origin);
  });

  it.each([
    "https://user:secret@cloud.example.test",
    "https://cloud.example.test/api",
    "https://cloud.example.test?token=secret",
    "https://cloud.example.test#secret",
    "file:///tmp/cloud",
    "invalid",
  ])("rejects non-origins without including their value in errors", (origin) => {
    const error = normalizeCloudOrigin(origin, true);
    expect(error).toBeInstanceOf(CloudOriginError);
    expect(error).toMatchObject({ reason: "invalid" });
    expect(String(error)).not.toContain(origin);
  });
});
