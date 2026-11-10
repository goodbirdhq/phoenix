import type { SalesDevice, SalesDevicePublicKey, SalesEnrolDeviceInput } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  deviceFingerprint,
  deviceIdFor,
  exportPublicKey,
  generateDeviceKey,
  shortFingerprint,
} from "./signing.ts";

/**
 * This client's device key for one engine. The private key is a non-extractable CryptoKey: a
 * store can persist it (IndexedDB keeps CryptoKey objects as they are) but nobody can read its
 * bytes, this client included.
 */
export interface SalesDeviceKey {
  /**
   * The engine it is enrolled with, as `salesEngineKey` gives it: one key per engine, whichever
   * environment reads it, since the engine is what enrols a device.
   */
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

/** This device as signing needs it. */
export interface SigningDevice {
  readonly key: SalesDeviceKey | null;
  readonly state: ThisDeviceState;
  /** Why this client may not hold a key at all (`salesDeviceBlockedReason`), or null. */
  readonly blocked: string | null;
}

export type SigningCheck =
  | { readonly key: SalesDeviceKey; readonly refusal: null }
  | {
      readonly key: null;
      readonly refusal: { readonly title: string; readonly description: string };
    };

/**
 * Whether this device may sign now, and the key to sign with: a client allowed to hold keys,
 * a key here, and the engine has it active. Every approve control and `approveVersions` ask
 * this, so a button never offers what signing would refuse.
 */
export function checkSigning(device: SigningDevice): SigningCheck {
  if (device.blocked !== null) {
    return {
      key: null,
      refusal: { title: "This client cannot approve", description: device.blocked },
    };
  }
  if (device.key === null || device.state !== "active") {
    return {
      key: null,
      refusal: {
        title: "This device cannot approve",
        description: thisDeviceDescription(device.state, device.key),
      },
    };
  }
  return { key: device.key, refusal: null };
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
