import type {
  SalesDevicePublicKey,
  SalesHashInput,
  SalesQueueItem,
  SalesQueueItemDetail,
  SalesSignedApproval,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * Signing approvals on this device. The server never holds a device key and never signs: the
 * key is made here, non-extractable, and every approval is signed here over the version this
 * client hashed itself from the text it shows. A tampered server can show one text and send a
 * hash of another, so the hash the engine reports is checked, never trusted. Only WebCrypto,
 * so web, desktop and (with a WebCrypto implementation) mobile share it.
 * See docs/internals/sales-approvals.md.
 */

/** The engine's name for its content hash (`hashAlgorithm` on `GET /queue/:activityId`). */
export const SALES_HASH_ALGORITHM =
  'sha256 hex of JSON.stringify([lowercased trimmed toAddress, subject.trim(), body, rowName.trim(), step, gmailThreadId ?? "", answers ?? ""])';

/** What a device signs to approve one version of one draft, at one moment. */
export const SALES_APPROVE_PREFIX = "birdhouse-approve:v1";

const encoder = new TextEncoder();

const toHex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

const toBase64Url = (bytes: ArrayBuffer) => {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
};

const sha256Hex = async (text: string, subtle: SubtleCrypto) =>
  toHex(await subtle.digest("SHA-256", encoder.encode(text)));

/** The engine's `contentHash()`, recomputed from its inputs. */
export function computeContentHash(
  input: SalesHashInput,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  return sha256Hex(
    JSON.stringify([
      input.toAddress.trim().toLowerCase(),
      input.subject.trim(),
      input.body,
      input.rowName.trim(),
      input.step,
      input.gmailThreadId ?? "",
      input.answers ?? "",
    ]),
    subtle,
  );
}

/** The exact text signed for one approval. */
export const approvalMessage = (activityId: string, contentHash: string, signedAt: string) =>
  `${SALES_APPROVE_PREFIX}\n${activityId}\n${contentHash}\n${signedAt}`;

/**
 * What the approval screen shows of a draft. Taken from the hash inputs, never from the
 * preview fields, so the text a person reads is the text the hash covers.
 */
export function displayedDraft(detail: SalesQueueItemDetail) {
  return {
    to: detail.hashInput.toAddress,
    subject: detail.hashInput.subject,
    body: detail.hashInput.body,
  };
}

export type VerifiedVersion =
  | { readonly ok: true; readonly contentHash: string }
  | {
      readonly ok: false;
      /** `algorithm`: the engine hashes some other way. `mismatch`: the shown text is not the hashed version. */
      readonly reason: "algorithm" | "mismatch";
    };

/**
 * Whether this client may sign for the draft as shown: the engine names the hash this client
 * knows, and hashing the displayed text gives the engine's `contentHash`. A mismatch means the
 * card moved on between reads, or something between here and the engine changed one side:
 * either way, read it again rather than sign.
 */
export async function verifyDisplayedVersion(
  detail: SalesQueueItemDetail,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<VerifiedVersion> {
  if (detail.hashAlgorithm !== SALES_HASH_ALGORITHM) return { ok: false, reason: "algorithm" };
  const contentHash = await computeContentHash(detail.hashInput, subtle);
  return contentHash === detail.contentHash.toLowerCase()
    ? { ok: true, contentHash }
    : { ok: false, reason: "mismatch" };
}

/**
 * Whether a card read for a batch approval is the version the list showed: the same hash, and
 * the text the list displayed (subject and the 280-character preview) agrees with the full text
 * that hash covers. A batch signs from the list, so this ties each signature to what was on
 * screen, as `verifyDisplayedVersion` does for the open draft.
 */
export function listedVersionMatches(
  listed: SalesQueueItem,
  detail: SalesQueueItemDetail,
): boolean {
  if (listed.activityId !== detail.activityId) return false;
  if (listed.contentHash.toLowerCase() !== detail.contentHash.toLowerCase()) return false;
  if (listed.subject.trim() !== detail.hashInput.subject.trim()) return false;
  const body = detail.hashInput.body.replace(/\s+/gu, " ").trim();
  const preview = listed.bodyPreview;
  return preview.endsWith("...")
    ? body.startsWith(preview.slice(0, -3).trimEnd())
    : body === preview.trim();
}

/**
 * Signs one approval of a version this client verified. `signedAt` is the moment of the
 * press, exactly as signed; the engine refuses one more than five minutes off its clock.
 */
export async function signApproval(input: {
  readonly privateKey: CryptoKey;
  readonly deviceId: string;
  readonly activityId: string;
  readonly contentHash: string;
  readonly signedAt?: string;
  readonly subtle?: SubtleCrypto;
}): Promise<SalesSignedApproval> {
  const subtle = input.subtle ?? globalThis.crypto.subtle;
  const signedAt = input.signedAt ?? DateTime.formatIso(DateTime.nowUnsafe());
  const signature = await subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    input.privateKey,
    encoder.encode(approvalMessage(input.activityId, input.contentHash, signedAt)),
  );
  // WebCrypto's ECDSA signature is IEEE P1363 (r then s, 64 bytes), which the engine expects.
  return {
    activityId: input.activityId,
    contentHash: input.contentHash,
    deviceId: input.deviceId,
    signedAt,
    signature: toBase64Url(signature),
  };
}

/** A new device key. The private half cannot be exported, so it never leaves this client. */
export function generateDeviceKey(
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<CryptoKeyPair> {
  return subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
}

/** The public half as the engine takes it: kty, crv, x and y only. */
export async function exportPublicKey(
  publicKey: CryptoKey,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<SalesDevicePublicKey> {
  const jwk = await subtle.exportKey("jwk", publicKey);
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("The device key is not a P-256 key.");
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

/**
 * The key's fingerprint as the engine and its Slack card compute it: sha256 hex of the RFC 7638
 * thumbprint input. The person approving the device in Slack compares its short form with the
 * one this device shows; it is the only thing that tells their key from one an agent enrolled.
 */
export const deviceFingerprint = (
  jwk: SalesDevicePublicKey,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
) => sha256Hex(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`, subtle);

/** The first 16 hex digits in fours, as the Slack card shows them. */
export const shortFingerprint = (fingerprint: string) =>
  (fingerprint.slice(0, 16).match(/.{4}/gu) ?? []).join(" ");

/**
 * A readable device id the engine accepts (1 to 64 of `A-Z a-z 0-9 . _ -`): the name as a slug,
 * then the fingerprint's first four digits, so two devices with one name stay apart.
 */
export function deviceIdFor(name: string, fingerprint: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 50);
  return `${slug || "device"}-${fingerprint.slice(0, 4)}`;
}
