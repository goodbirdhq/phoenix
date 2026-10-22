import { describe, expect, it } from "vite-plus/test";

import { formatAppDisplayName, resolveServerBackedAppDisplayName } from "./branding.logic.ts";

describe("formatAppDisplayName", () => {
  it("omits the stage suffix when there is no stage label", () => {
    expect(formatAppDisplayName({ baseName: "Phoenix", stageLabel: null })).toBe("Phoenix");
    expect(formatAppDisplayName({ baseName: "Phoenix", stageLabel: "Dev" })).toBe("Phoenix (Dev)");
  });
});

describe("resolveServerBackedAppDisplayName", () => {
  it("shows Nightly for a nightly server even when the app has no stage label", () => {
    const input = {
      baseName: "Phoenix",
      fallbackDisplayName: "Phoenix",
      fallbackStageLabel: null,
    };
    expect(
      resolveServerBackedAppDisplayName({
        ...input,
        primaryServerVersion: "0.0.43-nightly.20260929.2428",
      }),
    ).toBe("Phoenix (Nightly)");
    expect(resolveServerBackedAppDisplayName({ ...input, primaryServerVersion: "0.0.43" })).toBe(
      "Phoenix",
    );
  });
});
