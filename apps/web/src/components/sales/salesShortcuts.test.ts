// @vitest-environment jsdom

import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS, parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import { resolveSalesShortcut } from "./salesShortcuts";

const press = (key: string, extra: { shiftKey?: boolean; repeat?: boolean } = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  target: document.body,
  ...extra,
});

describe("Sales list shortcuts", () => {
  it("leaves a letter typed into a field alone", () => {
    const input = document.createElement("input");
    expect(
      resolveSalesShortcut({ ...press("a"), target: input }, DEFAULT_RESOLVED_KEYBINDINGS),
    ).toBeNull();
  });

  it("keeps moving while J is held, but approves and edits once per press", () => {
    expect(resolveSalesShortcut(press("j", { repeat: true }), DEFAULT_RESOLVED_KEYBINDINGS)).toBe(
      "sales.next",
    );
    expect(
      resolveSalesShortcut(press("a", { repeat: true }), DEFAULT_RESOLVED_KEYBINDINGS),
    ).toBeNull();
    expect(
      resolveSalesShortcut(press("e", { repeat: true }), DEFAULT_RESOLVED_KEYBINDINGS),
    ).toBeNull();
  });

  it("follows a rebinding, and the old key no longer approves", () => {
    const keybindings: ResolvedKeybindingsConfig = [
      ...DEFAULT_RESOLVED_KEYBINDINGS.filter((binding) => binding.command !== "sales.approve"),
      {
        command: "sales.approve",
        shortcut: parseKeybindingShortcut("shift+a")!,
        whenAst: { type: "identifier", name: "salesListOpen" },
      },
    ];
    expect(resolveSalesShortcut(press("a"), keybindings)).toBeNull();
    expect(resolveSalesShortcut(press("A", { shiftKey: true }), keybindings)).toBe("sales.approve");
  });
});
