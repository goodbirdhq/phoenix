import { describe, expect, it } from "vite-plus/test";

import { salesEngineKey, salesEngineRoot } from "./sales.ts";

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
