// @vitest-environment jsdom

import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";
import { resolveUsageShortcut } from "./usageShortcuts";

describe("Usage shortcuts while typing", () => {
  it.each(["input", "textarea"])("leaves letters to a focused %s", (tagName) => {
    const event = {
      key: "t",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      target: document.createElement(tagName),
    };

    expect(resolveUsageShortcut(event, DEFAULT_RESOLVED_KEYBINDINGS)).toBeNull();
    expect(
      resolveUsageShortcut({ ...event, target: document.body }, DEFAULT_RESOLVED_KEYBINDINGS),
    ).toBe("usage.tokens");
  });
});
