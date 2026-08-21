import { describe, expect, it } from "vitest";

import { canonicalJsonEqual, canonicalJsonHash, canonicalJsonValue } from "./canonical-json.ts";

describe("canonicalJsonValue", () => {
  it("sorts object keys", () => {
    expect(canonicalJsonValue({ b: 1, a: 2 })).toEqual({ a: 2, b: 1 });
    expect(JSON.stringify(canonicalJsonValue({ b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
  });

  it("sorts keys recursively, inside arrays too", () => {
    const value = {
      list: [
        { y: 1, x: 2 },
        { d: 3, c: 4 },
      ],
      z: 1,
      a: 2,
    };
    expect(JSON.stringify(canonicalJsonValue(value))).toBe(
      '{"a":2,"list":[{"x":2,"y":1},{"c":4,"d":3}],"z":1}',
    );
  });

  it("drops undefined object properties, like JSON.stringify does", () => {
    expect(canonicalJsonValue({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it("turns undefined array entries into null, like JSON.stringify does", () => {
    expect(canonicalJsonValue([1, undefined, 3])).toEqual([1, null, 3]);
  });

  it("leaves primitives and null untouched", () => {
    expect(canonicalJsonValue(null)).toBeNull();
    expect(canonicalJsonValue(42)).toBe(42);
    expect(canonicalJsonValue("x")).toBe("x");
    expect(canonicalJsonValue(true)).toBe(true);
  });

  it("rejects functions", () => {
    expect(() => canonicalJsonValue(() => {})).toThrow(TypeError);
    expect(() => canonicalJsonValue({ fn: () => {} })).toThrow(TypeError);
  });

  it("rejects cyclic references", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalJsonValue(cyclic)).toThrow(TypeError);
  });

  it("does not mistake the same object at two sibling positions for a cycle", () => {
    const shared = { x: 1 };
    expect(() => canonicalJsonValue({ left: shared, right: shared })).not.toThrow();
  });
});

describe("canonicalJsonHash", () => {
  it("is stable regardless of key order", () => {
    expect(canonicalJsonHash({ a: 1, b: 2 })).toBe(canonicalJsonHash({ b: 2, a: 1 }));
  });

  it("differs for structurally different values", () => {
    expect(canonicalJsonHash({ a: 1 })).not.toBe(canonicalJsonHash({ a: 2 }));
  });

  it("is a 64-character hex sha256 digest", () => {
    expect(canonicalJsonHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a top-level undefined value", () => {
    expect(() => canonicalJsonHash(undefined)).toThrow(TypeError);
  });
});

describe("canonicalJsonEqual", () => {
  it("treats key-order-shuffled objects as equal", () => {
    expect(canonicalJsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it("treats structurally different objects as unequal", () => {
    expect(canonicalJsonEqual({ a: 1 }, { a: 2 })).toBe(false);
  });
});
