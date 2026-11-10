import type { SalesDevice, SalesDevicePublicKey, SalesEnrolDeviceInput } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  deviceFingerprint,
  deviceIdFor,
  exportPublicKey,
  generateDeviceKey,
  shortFingerprint,
} from "./approval.ts";

/**
 * This client's device key for one engine. The private key is a non-extractable CryptoKey: a
 * store can persist it (IndexedDB keeps CryptoKey objects as they are) but nobody can read its
 * bytes, this client included.
 */
export interface SalesDeviceKey {
  /** The engine it is enrolled with, as `salesEngineKey` gives it. */
  readonly engine: string;
  readonly deviceId: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly publicKeyJwk: SalesDevicePublicKey;
  readonly privateKey: CryptoKey;
  readonly createdAt: string;
}

/** Where a platform keeps device keys: IndexedDB on web and desktop. */
export interface SalesDeviceKeyStore {
  readonly load: (engine: string) => Promise<SalesDeviceKey | null>;
  readonly save: (key: SalesDeviceKey) => Promise<void>;
  readonly remove: (engine: string) => Promise<void>;
}

/** One key per engine, whichever environment reads it: the engine is what enrols a device. */
export function salesEngineKey(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/u, "").toLowerCase();
}

/** Makes a key for `name` and the request that enrols it. Nothing is stored or sent here. */
export async function createDeviceKey(input: {
  readonly engine: string;
  readonly name: string;
  readonly subtle?: SubtleCrypto;
}): Promise<{ readonly key: SalesDeviceKey; readonly enrol: SalesEnrolDeviceInput }> {
  const subtle = input.subtle ?? globalThis.crypto.subtle;
  const pair = await generateDeviceKey(subtle);
  const publicKeyJwk = await exportPublicKey(pair.publicKey, subtle);
  const fingerprint = await deviceFingerprint(publicKeyJwk, subtle);
  const name = input.name.trim().slice(0, 80) || "Phoenix device";
  const deviceId = deviceIdFor(name, fingerprint);
  return {
    key: {
      engine: input.engine,
      deviceId,
      name,
      fingerprint,
      publicKeyJwk,
      privateKey: pair.privateKey,
      createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
    },
    enrol: { deviceId, name, publicKeyJwk },
  };
}

/**
 * Where this device stands with the engine:
 * - `none`: no key here.
 * - `unchecked`: a key here, the engine's device list not read yet.
 * - `pending`: waiting for the Approve press on its Slack card.
 * - `active`: signs approvals.
 * - `rejected`, `revoked`: signs nothing, ever; enrol a new key.
 * - `unknown`: the engine has no device by this id, or one with another key.
 */
export type ThisDeviceState =
  | "none"
  | "unchecked"
  | "pending"
  | "active"
  | "rejected"
  | "revoked"
  | "unknown";

export function thisDeviceState(
  key: SalesDeviceKey | null,
  devices: ReadonlyArray<SalesDevice> | null,
): ThisDeviceState {
  if (key === null) return "none";
  if (devices === null) return "unchecked";
  const device = devices.find((entry) => entry.deviceId === key.deviceId);
  if (device === undefined || device.fingerprint.toLowerCase() !== key.fingerprint) {
    return "unknown";
  }
  switch (device.state) {
    case "pending":
    case "active":
    case "rejected":
    case "revoked":
      return device.state;
    default:
      return "unknown";
  }
}

/** What to tell the person about this device, wherever approval is offered. */
export function thisDeviceDescription(state: ThisDeviceState, key: SalesDeviceKey | null): string {
  const fingerprint = key === null ? "" : ` (${shortFingerprint(key.fingerprint)})`;
  switch (state) {
    case "none":
      return "This device is not enrolled, so it cannot approve. Enrol it in Settings › Integrations.";
    case "unchecked":
      return `Checking this device${fingerprint} with the engine…`;
    case "pending":
      return `This device${fingerprint} waits for Approve device on its Slack card. Check the fingerprint matches.`;
    case "active":
      return `This device${fingerprint} can approve.`;
    case "rejected":
      return "This device's enrolment was rejected in Slack. Enrol it again to make a new key.";
    case "revoked":
      return "This device was revoked and signs nothing. Enrol it again to make a new key.";
    case "unknown":
      return "The engine does not know this device's key. Enrol it again.";
  }
}
