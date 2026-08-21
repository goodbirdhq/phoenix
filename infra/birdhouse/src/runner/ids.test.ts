import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vitest";

import { deriveRunPhoenixIds } from "./ids.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("deriveRunPhoenixIds", () => {
  it("is stable for the same runId", () => {
    const runId = NodeCrypto.randomUUID();
    expect(deriveRunPhoenixIds(runId)).toEqual(deriveRunPhoenixIds(runId));
  });

  it("produces distinct ids per purpose", () => {
    const ids = deriveRunPhoenixIds(NodeCrypto.randomUUID());
    const values = Object.values(ids);
    expect(new Set(values).size).toBe(values.length);
  });

  it("produces distinct ids across different runs", () => {
    const a = deriveRunPhoenixIds(NodeCrypto.randomUUID());
    const b = deriveRunPhoenixIds(NodeCrypto.randomUUID());
    expect(a.threadId).not.toBe(b.threadId);
    expect(a.createCommandId).not.toBe(b.createCommandId);
    expect(a.turnCommandId).not.toBe(b.turnCommandId);
    expect(a.messageId).not.toBe(b.messageId);
  });

  it("emits valid uuid-shaped strings", () => {
    const ids = deriveRunPhoenixIds(NodeCrypto.randomUUID());
    for (const value of Object.values(ids)) {
      expect(value).toMatch(UUID_RE);
    }
  });
});
