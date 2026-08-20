import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The run-result callback token: a single-purpose bearer credential handed
 * to the Phoenix agent so it can report back to `POST /api/runs/:id/result`.
 * Only the sha256 hash is stored on the run row (`callback_token_hash`); the
 * raw token lives only in the `workflow.launch` job's payload, which is the
 * same trusted database as everything else here — an accepted tradeoff, not
 * a real secret boundary. It authenticates one call for one run, not a
 * standing credential.
 */
export interface CallbackToken {
  token: string;
  hash: string;
}

export function hashCallbackToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export function mintCallbackToken(): CallbackToken {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashCallbackToken(token) };
}

/**
 * Constant-time comparison against the stored hash, so a wrong guess can't
 * be distinguished by timing from a near-miss. Comparing hex-encoded sha256
 * digests, which are always 64 characters, so the length check below only
 * ever trips on a malformed stored hash — not a state worth leaking timing
 * about either.
 */
export function verifyCallbackToken(rawToken: string, storedHashHex: string): boolean {
  const computed = Buffer.from(hashCallbackToken(rawToken), "utf8");
  const stored = Buffer.from(storedHashHex, "utf8");
  if (computed.length !== stored.length) return false;
  return timingSafeEqual(computed, stored);
}
