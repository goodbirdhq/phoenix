import { describe, expect, it } from "vitest";

import { hashCallbackToken, mintCallbackToken, verifyCallbackToken } from "./callbackToken.ts";

describe("mintCallbackToken / verifyCallbackToken", () => {
  it("verifies the token it minted against its own hash", () => {
    const { token, hash } = mintCallbackToken();
    expect(verifyCallbackToken(token, hash)).toBe(true);
  });

  it("rejects an incorrect token", () => {
    const { hash } = mintCallbackToken();
    const other = mintCallbackToken();
    expect(verifyCallbackToken(other.token, hash)).toBe(false);
  });

  it("rejects a token that just hashes to a different value", () => {
    const hash = hashCallbackToken("correct-token");
    expect(verifyCallbackToken("wrong-token", hash)).toBe(false);
    expect(verifyCallbackToken("correct-token", hash)).toBe(true);
  });

  it("does not throw on a malformed/short stored hash (timing-safe path guards length first)", () => {
    expect(() => verifyCallbackToken("anything", "short")).not.toThrow();
    expect(verifyCallbackToken("anything", "short")).toBe(false);
  });

  it("mints tokens that are not trivially guessable/repeating", () => {
    const first = mintCallbackToken();
    const second = mintCallbackToken();
    expect(first.token).not.toBe(second.token);
    expect(first.hash).not.toBe(second.hash);
    expect(first.token.length).toBeGreaterThanOrEqual(32);
  });
});
