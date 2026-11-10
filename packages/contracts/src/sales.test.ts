import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  SalesActionError,
  parseSalesDispatchThreadId,
  salesDispatchThreadPrefix,
  salesEngineKey,
  salesEngineRoot,
} from "./sales.ts";

describe("salesEngineRoot", () => {
  it("reads the origin and the API base as the same engine", () => {
    for (const entered of [
      "https://engine.example.com",
      " https://engine.example.com/ ",
      "https://engine.example.com/api/sales/v1",
      "https://engine.example.com/api/sales/v1//",
    ]) {
      expect(salesEngineRoot(entered)).toBe("https://engine.example.com");
    }
  });

  it("keeps a path the engine sits under", () => {
    expect(salesEngineRoot("https://example.com/birdhouse/api/sales/v1/")).toBe(
      "https://example.com/birdhouse",
    );
  });

  it("refuses anything but an http or https URL", () => {
    expect(salesEngineRoot("ftp://engine.example.com")).toBeNull();
    expect(salesEngineRoot("engine.example.com")).toBeNull();
    expect(salesEngineRoot("")).toBeNull();
  });
});

describe("salesEngineKey", () => {
  it("gives one key for every spelling of one engine", () => {
    expect(
      new Set(
        [
          "https://engine.example.com",
          "HTTPS://Engine.Example.com/",
          "https://engine.example.com/api/sales/v1",
        ].map(salesEngineKey),
      ),
    ).toEqual(new Set(["https://engine.example.com"]));
  });

  it("tells different engines apart", () => {
    expect(salesEngineKey("https://engine.example.com")).not.toBe(
      salesEngineKey("https://other.example.com"),
    );
  });

  it("keys text that is not a URL as itself", () => {
    expect(salesEngineKey("  Not A URL ")).toBe("not a url");
  });
});

const decodeSalesActionError = Schema.decodeUnknownSync(SalesActionError);

describe("SalesActionError", () => {
  it("reads a failure from a server without origins as the transport's, which claims least", () => {
    const error = decodeSalesActionError({
      _tag: "SalesActionError",
      reason: "not-configured",
      message: "Not set up.",
      currentHash: null,
      state: null,
    });
    expect(error.origin).toBe("transport");
  });
});

describe("dispatch thread ids", () => {
  it("reads back the card or conversation each id was made for", () => {
    for (const source of [
      { activityId: "act-1" },
      { activityId: "act-10" },
      { contactKey: "3a2b9c1d-0000-4000-8000-000000000001" },
      { activityId: "a:b" },
      { contactKey: "key:with:colons%" },
    ]) {
      expect(parseSalesDispatchThreadId(`${salesDispatchThreadPrefix(source)}t1`)).toEqual(source);
    }
  });

  it("keeps one card's prefix from matching another's", () => {
    const id = `${salesDispatchThreadPrefix({ activityId: "act-10" })}t1`;
    expect(id.startsWith(salesDispatchThreadPrefix({ activityId: "act-1" }))).toBe(false);
    expect(
      `${salesDispatchThreadPrefix({ activityId: "a:b" })}t1`.startsWith(
        salesDispatchThreadPrefix({ activityId: "a" }),
      ),
    ).toBe(false);
  });

  it("reads any other thread as not dispatched", () => {
    for (const id of ["thread-4", "sales:card:a:b:t1", "sales:card::t1", "sales:card:%zz:t1"]) {
      expect(parseSalesDispatchThreadId(id)).toBeNull();
    }
  });
});
