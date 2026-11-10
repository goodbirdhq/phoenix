import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS, parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveSalesShortcut } from "./salesShortcuts";

class TestElement extends EventTarget {
  constructor(
    readonly tagName: string,
    readonly isContentEditable = false,
  ) {
    super();
  }
}

const press = (key: string, target: EventTarget = new TestElement("BODY")) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  target,
});

let dialogOpen = false;
beforeEach(() => {
  dialogOpen = false;
  vi.stubGlobal("HTMLElement", TestElement);
  vi.stubGlobal("navigator", { platform: "Linux" });
  vi.stubGlobal("document", { querySelector: () => (dialogOpen ? {} : null) });
});
afterEach(() => vi.unstubAllGlobals());

describe("Sales list shortcuts", () => {
  it("resolves the default letters on a Sales list", () => {
    expect(resolveSalesShortcut(press("a"), DEFAULT_RESOLVED_KEYBINDINGS)).toBe("sales.approve");
    expect(resolveSalesShortcut(press("j"), DEFAULT_RESOLVED_KEYBINDINGS)).toBe("sales.next");
  });

  it.each([new TestElement("INPUT"), new TestElement("TEXTAREA"), new TestElement("DIV", true)])(
    "leaves letters to the focused $tagName field",
    (target) => {
      expect(resolveSalesShortcut(press("a", target), DEFAULT_RESOLVED_KEYBINDINGS)).toBeNull();
    },
  );

  it("stands down while a dialog is open", () => {
    dialogOpen = true;
    expect(resolveSalesShortcut(press("a"), DEFAULT_RESOLVED_KEYBINDINGS)).toBeNull();
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
    expect(resolveSalesShortcut({ ...press("A"), shiftKey: true }, keybindings)).toBe(
      "sales.approve",
    );
  });
});
