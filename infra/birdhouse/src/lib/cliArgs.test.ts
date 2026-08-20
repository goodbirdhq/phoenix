import { describe, expect, it } from "vitest";

import { positionalArgs, readFlag } from "./cliArgs.ts";

describe("readFlag", () => {
  it("reads both --flag value and --flag=value", () => {
    expect(readFlag(["--input", "{}"], "--input")).toBe("{}");
    expect(readFlag(['--input={"a":1}'], "--input")).toBe('{"a":1}');
  });

  it("treats a trailing or flag-followed flag as absent rather than eating the next flag", () => {
    expect(readFlag(["--input"], "--input")).toBeUndefined();
    expect(readFlag(["--limit", "--verbose"], "--limit")).toBeUndefined();
  });

  it("is undefined when the flag isn't present", () => {
    expect(readFlag(["run", "my-workflow"], "--input")).toBeUndefined();
  });
});

describe("positionalArgs", () => {
  it("drops known flags in both spellings, keeping positionals in order", () => {
    expect(positionalArgs(["my-workflow", "--input", "{}"], ["--input"])).toEqual(["my-workflow"]);
    expect(positionalArgs(["--input={}", "my-workflow"], ["--input"])).toEqual(["my-workflow"]);
  });

  it("does not consume the next flag as a valueless flag's value", () => {
    expect(positionalArgs(["--input", "--other", "key"], ["--input"])).toEqual(["--other", "key"]);
  });
});
