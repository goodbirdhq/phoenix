// @effect-diagnostics globalFetch:off - Exercises the real loopback callback without Cloud credentials.
import { describe, expect, it } from "vite-plus/test";
import { preparePhoenixCloudCallback } from "@t3tools/shared/phoenixCloudCallback";

function authorization(redirectUri: string) {
  const url = new URL("https://cloud.example/api/auth/oauth2/authorize");
  url.search = new URLSearchParams({
    redirect_uri: redirectUri,
    state: "server-owned-state",
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: "a".repeat(43),
  }).toString();
  return url.toString();
}
function callback(redirectUri: string) {
  const url = new URL(redirectUri);
  url.search = new URLSearchParams({
    state: "server-owned-state",
    code: "one-time-code",
    iss: "https://cloud.example/api/auth",
  }).toString();
  return url;
}

describe("Phoenix Cloud desktop callback", () => {
  it("binds an ephemeral literal loopback listener before launch and rejects foreign responses", async () => {
    const listener = await preparePhoenixCloudCallback();
    try {
      expect(new URL(listener.redirectUri).hostname).toBe("127.0.0.1");
      expect((await fetch(callback(listener.redirectUri))).status).toBe(400);
      const expected = callback(listener.redirectUri);
      const received = await listener.receive(authorization(listener.redirectUri), async () => {
        for (const [key, value] of [
          ["state", "foreign"],
          ["iss", "https://foreign.example/api/auth"],
        ]) {
          const invalid = new URL(expected);
          invalid.searchParams.set(key!, value!);
          expect((await fetch(invalid)).status).toBe(400);
        }
        const response = await fetch(expected);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.text()).not.toContain("one-time-code");
        return true;
      });
      expect(received).toBe(expected.toString());
      await expect(fetch(expected)).rejects.toThrow();
    } finally {
      listener.cancel();
    }
  });

  it("delivers denial for the initiating state and issuer", async () => {
    const listener = await preparePhoenixCloudCallback();
    try {
      const denied = callback(listener.redirectUri);
      denied.searchParams.delete("code");
      denied.searchParams.set("error", "access_denied");
      expect(
        await listener.receive(authorization(listener.redirectUri), async () => {
          expect((await fetch(denied)).status).toBe(200);
          return true;
        }),
      ).toBe(denied.toString());
    } finally {
      listener.cancel();
    }
  });

  it("rejects a mismatched redirect before browser launch and releases cancelled listeners", async () => {
    const listener = await preparePhoenixCloudCallback();
    const other = await preparePhoenixCloudCallback();
    try {
      await expect(
        listener.receive(authorization(other.redirectUri), async () => {
          throw new Error("must not launch");
        }),
      ).rejects.toThrow("Invalid Phoenix");
      const receiving = other.receive(authorization(other.redirectUri), async () => {
        other.cancel();
        return true;
      });
      await expect(receiving).rejects.toThrow("cancelled or expired");
      await expect(fetch(callback(other.redirectUri))).rejects.toThrow();
    } finally {
      listener.cancel();
      other.cancel();
    }
  });
});
