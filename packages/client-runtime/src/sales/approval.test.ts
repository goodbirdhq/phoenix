import type { SalesDevice, SalesQueueItemDetail } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  SALES_HASH_ALGORITHM,
  approvalMessage,
  computeContentHash,
  deviceFingerprint,
  deviceIdFor,
  displayedDraft,
  exportPublicKey,
  listedVersionMatches,
  generateDeviceKey,
  shortFingerprint,
  signApproval,
  verifyDisplayedVersion,
} from "./approval.ts";
import { createDeviceKey, thisDeviceState } from "./devices.ts";

/**
 * Hash inputs with the white space the engine normalises, and the hash the engine's own
 * `contentHash()` (birdhouse engine `src/approval/core.ts`, at 80f689f) gives for them.
 */
const hashInput = {
  toAddress: "  Ana@Brand.example ",
  subject: " Re: creator x fintech ",
  body: "Hey Ana,\n\nThanks for the note — two quick ideas.\n\n  Gabe ",
  rowName: "Draft chase to Ana - Brand ",
  step: 2,
  gmailThreadId: "18f2c0ffee",
  answers: null,
};
const ENGINE_HASH = "add70f992ed114c2f0fc16adc5f24f4fd3980e7a246de05a43421a9a5c700386";

const detail = (overrides: Partial<SalesQueueItemDetail> = {}): SalesQueueItemDetail => ({
  activityId: "act-1",
  kind: "chase",
  step: 2,
  stepLabel: "Email 2",
  contact: {
    id: "c1",
    name: "Ana",
    email: "ana@brand.example",
    accountName: "Brand",
    timeZone: null,
    effectiveTimeZone: "America/Los_Angeles",
    notionUrl: "https://www.notion.so/c1",
    linkedinUrl: null,
  },
  campaign: null,
  subject: "Re: creator x fintech",
  threaded: true,
  bodyPreview: "Hey Ana, Thanks for the note",
  contentHash: ENGINE_HASH,
  state: "awaiting",
  approval: null,
  sendAt: null,
  goes: null,
  mailbox: { sticky: true, address: "gabe@trygoodbird.com", threadState: "open" },
  refusal: null,
  note: null,
  check: null,
  skip: null,
  sendStatus: null,
  notionUrl: "https://www.notion.so/act1",
  rowEditedAt: null,
  body: hashInput.body,
  rowName: hashInput.rowName,
  hashInput,
  hashAlgorithm: SALES_HASH_ALGORITHM,
  ...overrides,
});

const fromBase64Url = (value: string) =>
  Uint8Array.from(atob(value.replace(/-/gu, "+").replace(/_/gu, "/")), (char) =>
    char.charCodeAt(0),
  );

describe("content hash", () => {
  it("matches the engine's hash for the same inputs", async () => {
    expect(await computeContentHash(hashInput)).toBe(ENGINE_HASH);
  });

  it("lets a client sign only the version it shows", async () => {
    expect(await verifyDisplayedVersion(detail())).toEqual({ ok: true, contentHash: ENGINE_HASH });
    // What the screen shows is the hash inputs, not the preview fields.
    expect(displayedDraft(detail()).body).toBe(hashInput.body);
  });

  it("refuses a body that is not the hashed version", async () => {
    // A server that swaps the text but keeps the engine's hash, so a signature would approve
    // words nobody read.
    const tampered = detail({ hashInput: { ...hashInput, body: "Wire the money." } });
    expect(await verifyDisplayedVersion(tampered)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses a hash it does not know how to recompute", async () => {
    const other = detail({ hashAlgorithm: "sha512 of something else" });
    expect(await verifyDisplayedVersion(other)).toEqual({ ok: false, reason: "algorithm" });
  });
});

describe("batch approval", () => {
  it("signs a listed row only when the card is still the version the list showed", () => {
    const shown = detail();
    const listed = {
      ...shown,
      bodyPreview: "Hey Ana, Thanks for the note — two quick ideas. Gabe",
    };
    expect(listedVersionMatches(listed, shown)).toBe(true);
    // A cut preview matches the start of the body.
    expect(listedVersionMatches({ ...listed, bodyPreview: "Hey Ana, Thanks for..." }, shown)).toBe(
      true,
    );
    // The card moved on since the list was read.
    expect(listedVersionMatches({ ...listed, contentHash: "0".repeat(64) }, shown)).toBe(false);
    // The list showed other words than the hash covers.
    expect(listedVersionMatches({ ...listed, bodyPreview: "Wire the money." }, shown)).toBe(false);
    expect(listedVersionMatches({ ...listed, subject: "Another subject" }, shown)).toBe(false);
  });
});

describe("signing", () => {
  it("signs the engine's canonical string with a key that cannot be exported", async () => {
    const pair = await generateDeviceKey();
    await expect(crypto.subtle.exportKey("jwk", pair.privateKey)).rejects.toThrow();

    const signed = await signApproval({
      privateKey: pair.privateKey,
      deviceId: "laptop-3f2a",
      activityId: "act-1",
      contentHash: ENGINE_HASH,
      signedAt: "2026-11-10T09:14:03.120Z",
    });
    expect(approvalMessage("act-1", ENGINE_HASH, "2026-11-10T09:14:03.120Z")).toBe(
      `birdhouse-approve:v1\nact-1\n${ENGINE_HASH}\n2026-11-10T09:14:03.120Z`,
    );
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
  it("fingerprints the RFC 7638 input the Slack card shows", async () => {
    const jwk = {
      kty: "EC" as const,
      crv: "P-256" as const,
      x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
      y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
    };
    const canonical = `{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`;
    const expected = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const fingerprint = await deviceFingerprint(jwk);
    expect(fingerprint).toBe(expected);
    expect(shortFingerprint(fingerprint)).toMatch(
      /^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/u,
    );
  });

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
