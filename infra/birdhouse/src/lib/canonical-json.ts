import * as NodeCrypto from "node:crypto";

/**
 * Canonicalizes a JSON-like value: object keys sorted, `undefined`
 * properties dropped (matching `JSON.stringify`'s own behaviour), so
 * structurally equal values serialize identically regardless of property
 * insertion order. Postgres jsonb rewrites key order, so a value read back
 * from the database never stringifies byte-identically to a freshly built
 * object — canonicalize both sides before comparing or hashing.
 *
 * Functions and cyclic references have no canonical JSON form, so both throw
 * rather than silently producing `null` or looping forever. `seen` tracks
 * only the current ancestor chain (removed on the way back out), so the same
 * object appearing twice in sibling positions is not mistaken for a cycle.
 */
export function canonicalJsonValue(value: unknown, seen: Set<unknown> = new Set()): unknown {
  if (typeof value === "function") {
    throw new TypeError("canonicalJsonValue: functions have no canonical JSON form");
  }
  if (value === undefined || value === null || typeof value !== "object") return value;

  if (seen.has(value)) {
    throw new TypeError("canonicalJsonValue: cyclic reference has no canonical JSON form");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      // JSON.stringify serializes an `undefined` array entry as `null`;
      // match that here so hashing agrees with what stringify would produce.
      return value.map((item) => canonicalJsonValue(item, seen) ?? null);
    }
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        const entry = canonicalJsonValue((value as Record<string, unknown>)[key], seen);
        if (entry !== undefined) result[key] = entry;
        return result;
      }, {});
  } finally {
    seen.delete(value);
  }
}

/**
 * SHA-256 hex digest over the canonical form. This is the digest behind
 * workflow manifest hashes, so it is a stored contract: the same logical
 * manifest must hash the same on every machine and in every release.
 */
export function canonicalJsonHash(value: unknown): string {
  const canonical = canonicalJsonValue(value);
  const json = JSON.stringify(canonical);
  if (json === undefined) {
    throw new TypeError("canonicalJsonHash: value has no canonical JSON form (undefined)");
  }
  return NodeCrypto.createHash("sha256").update(json).digest("hex");
}

/** Structural equality under the canonical form. */
export function canonicalJsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}
