import type { SalesDevice } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  approvalMessage,
  computeContentHash,
  deviceIdFor,
  displayedDraft,
  exportPublicKey,
  generateDeviceKey,
  signApproval,
  verifyDisplayedVersion,
  verifyReviewedVersion,
} from "./signing.ts";
import { createDeviceKey, thisDeviceState } from "./devices.ts";
import { ENGINE_HASH, detail, hashInput } from "./fixtures/queueItemDetail.ts";

const fromBase64Url = (value: string) =>
  Uint8Array.from(atob(value.replace(/-/gu, "+").replace(/_/gu, "/")), (char) =>
    char.charCodeAt(0),
  );

describe("content hash", () => {
  it("lets a client sign only the version it shows", async () => {
    expect(await verifyDisplayedVersion(detail())).toEqual({
      ok: true,
      version: { activityId: "act-1", contentHash: ENGINE_HASH },
    });
    // What the screen shows is the hash inputs, not the preview fields.
    expect(displayedDraft(detail()).body).toBe(hashInput.body);
  });

  it("refuses a body that is not the hashed version", async () => {
    // A server that swaps the text but keeps the engine's hash, so a signature would approve
    // words nobody read.
    const tampered = detail({ hashInput: { ...hashInput, body: "Wire the money." } });
    expect(await verifyDisplayedVersion(tampered)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses text a person would not see as it is sent, even when it is the hashed version", async () => {
    const verifies = async (patch: Partial<typeof hashInput>) => {
      const input = { ...hashInput, ...patch };
      return verifyDisplayedVersion(
        detail({ hashInput: input, contentHash: await computeContentHash(input) }),
      );
    };
    // A one-line field would show the subject without its break.
    expect(await verifies({ subject: "Re: creator\nx fintech" })).toEqual({
      ok: false,
      reason: "hidden-text",
    });
    expect(await verifies({ body: "Hey Ana,\u202Eyenom eht eriw\u202C" })).toEqual({
      ok: false,
      reason: "hidden-text",
    });
    expect(await verifies({ body: `Hey Ana,${"\n".repeat(40)}P.S. wire it.` })).toEqual({
      ok: false,
      reason: "hidden-text",
    });
    expect(await verifies({ toAddress: "ana@brаnd.example" })).toEqual({
      ok: false,
      reason: "address",
    });
    expect(await verifies({ body: "Olá Ana 👋\r\n\r\nGabriel" })).toMatchObject({ ok: true });
  });

  it("refuses a hash it does not know how to recompute", async () => {
    const other = detail({ hashAlgorithm: "sha512 of something else" });
    expect(await verifyDisplayedVersion(other)).toEqual({ ok: false, reason: "algorithm" });
  });
});

describe("batch approval", () => {
  it("signs a reviewed draft only when it is the version the person ticked", async () => {
    expect(await verifyReviewedVersion(detail(), ENGINE_HASH.toUpperCase())).toEqual({
      ok: true,
      version: { activityId: "act-1", contentHash: ENGINE_HASH },
    });
  });

  it("refuses a draft whose content moved on after the tick, even when it verifies", async () => {
    // The next poll swapped the card for a new, self-consistent version: the engine's hash and
    // the hash inputs agree, but the person ticked the old one.
    const newer = { ...hashInput, body: "Hey Ana,\n\nOne more idea.\n" };
    const moved = detail({ hashInput: newer, contentHash: await computeContentHash(newer) });
    expect(await verifyDisplayedVersion(moved)).toMatchObject({ ok: true });
    expect(await verifyReviewedVersion(moved, ENGINE_HASH)).toEqual({
      ok: false,
      reason: "changed",
    });
  });

  it("refuses a reviewed draft whose text is not the hashed version", async () => {
    const tampered = detail({ hashInput: { ...hashInput, body: "Wire the money." } });
    expect(await verifyReviewedVersion(tampered, ENGINE_HASH)).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });
});

describe("signing", () => {
  it("signs the engine's canonical string with a key that cannot be exported", async () => {
    const pair = await generateDeviceKey();
    await expect(crypto.subtle.exportKey("jwk", pair.privateKey)).rejects.toThrow();

    const check = await verifyDisplayedVersion(detail());
    if (!check.ok) throw new Error("The fixture should verify.");
    const signed = await signApproval({
      privateKey: pair.privateKey,
      deviceId: "laptop-3f2a",
      version: check.version,
      signedAt: "2026-11-10T09:14:03.120Z",
    });
    expect(signed).toMatchObject({
      activityId: "act-1",
      contentHash: ENGINE_HASH,
      deviceId: "laptop-3f2a",
      signedAt: "2026-11-10T09:14:03.120Z",
    });
    expect(signed.signature).toMatch(/^[A-Za-z0-9_-]+$/u);
    const signature = fromBase64Url(signed.signature);
    // IEEE P1363, r then s: the engine refuses DER.
    expect(signature.length).toBe(64);

    // The engine verifies with the public JWK the device enrolled.
    const publicJwk = await exportPublicKey(pair.publicKey);
    const verifier = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const message = new TextEncoder().encode(
      approvalMessage("act-1", ENGINE_HASH, "2026-11-10T09:14:03.120Z"),
    );
    expect(
      await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, signature, message),
    ).toBe(true);
    const otherVersion = new TextEncoder().encode(
      approvalMessage("act-1", "0".repeat(64), "2026-11-10T09:14:03.120Z"),
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verifier,
        signature,
        otherVersion,
      ),
    ).toBe(false);
  });
});

describe("device keys", () => {
  it("makes an enrolment the engine accepts and sends only the public half", async () => {
    const { key, enrol } = await createDeviceKey({
      engine: "https://engine.example.com",
      name: "Gabriel's MacBook Pro ✨",
    });
    expect(enrol.deviceId).toMatch(/^[A-Za-z0-9._-]{1,64}$/u);
    expect(enrol.deviceId).toBe(`gabriel-s-macbook-pro-${key.fingerprint.slice(0, 4)}`);
    expect(Object.keys(enrol.publicKeyJwk).toSorted()).toEqual(["crv", "kty", "x", "y"]);
    expect(key.privateKey.extractable).toBe(false);
    expect(deviceIdFor("", "abcd1234")).toBe("device-abcd");
  });

  it("reads this device's state from the engine's list", () => {
    const key = {
      engine: "e",
      deviceId: "laptop-3f2a",
      name: "Laptop",
      fingerprint: "3f2a".repeat(16),
      publicKeyJwk: { kty: "EC" as const, crv: "P-256" as const, x: "x", y: "y" },
      privateKey: {} as CryptoKey,
      createdAt: "2026-11-10T09:00:00.000Z",
    };
    const device = (state: string, fingerprint = key.fingerprint): SalesDevice => ({
      deviceId: key.deviceId,
      name: "Laptop",
      state,
      fingerprint,
      fingerprintShort: "",
      createdAt: null,
      decidedAt: null,
      revokedBy: null,
      revokedAt: null,
      lastUsedAt: null,
    });
    expect(thisDeviceState(null, [])).toBe("none");
    expect(thisDeviceState(key, null)).toBe("unchecked");
    expect(thisDeviceState(key, [])).toBe("unknown");
    expect(thisDeviceState(key, [device("pending")])).toBe("pending");
    expect(thisDeviceState(key, [device("active")])).toBe("active");
    expect(thisDeviceState(key, [device("revoked")])).toBe("revoked");
    // Same id, another key: not this device.
    expect(thisDeviceState(key, [device("active", "0".repeat(64))])).toBe("unknown");
  });
});
