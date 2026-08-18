import { describe, expect, it } from "@effect/vitest";

import { formatCliVersion, type BuildCommit } from "./buildInfo.ts";

describe("formatCliVersion", () => {
  const commit = (value: string): BuildCommit => ({ kind: "commit", value });

  it("names the commit a release build was built from", () => {
    expect(formatCliVersion("0.0.33", commit("b421b138"))).toBe("0.0.33 (b421b138)");
  });

  it("keeps the dirty marker so a build from uncommitted work cannot pass as its base commit", () => {
    expect(formatCliVersion("0.0.33", commit("b421b138-dirty"))).toBe("0.0.33 (b421b138-dirty)");
  });

  it("says source when running straight from the repo, where nothing was baked in", () => {
    expect(formatCliVersion("0.0.33", { kind: "source" })).toBe("0.0.33 (source)");
  });

  it("admits an unknown commit rather than inventing one", () => {
    expect(formatCliVersion("0.0.33", { kind: "unknown" })).toBe("0.0.33 (unknown commit)");
  });
});
