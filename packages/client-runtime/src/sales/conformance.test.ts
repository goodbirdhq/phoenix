import { describe, expect, it } from "vite-plus/test";

import {
  SALES_HASH_ALGORITHM,
  approvalMessage,
  computeContentHash,
  deviceFingerprint,
  shortFingerprint,
} from "./signing.ts";
// The engine's conformance vectors, copied verbatim from goodbirdhq/birdhouse
// `engine/docs/sales-api-vectors.json` at d3d6c38fa256bb2c672055191252d54c842947bb. Copy the file
// again when the engine changes it; never edit the copy.
import vectors from "./fixtures/sales-api-vectors.json" with { type: "json" };

describe("sales API conformance vectors", () => {
  it("names the hash and approve message this client implements", () => {
    expect(vectors.hashAlgorithm).toBe(SALES_HASH_ALGORITHM);
    expect(approvalMessage("a", "h", "t").split("\n")[0]).toBe(vectors.approvePrefix);
  });

  it.each(vectors.contentHash)("hashes $name", async ({ input, expected }) => {
    expect(await computeContentHash(input)).toBe(expected);
  });

  it.each(vectors.approveMessage)("builds the $name", ({ input, expected }) => {
    expect(approvalMessage(input.activityId, input.contentHash, input.signedAt)).toBe(expected);
  });

  it.each(vectors.fingerprint)("fingerprints $name", async ({ input, expected }) => {
    const jwk = { kty: "EC" as const, crv: "P-256" as const, x: input.x, y: input.y };
    const fingerprint = await deviceFingerprint(jwk);
    expect(fingerprint).toBe(expected.fingerprint);
    expect(shortFingerprint(fingerprint)).toBe(expected.fingerprintShort);
  });
});
