// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vite-plus/test";

import { isPageShortcutSuppressed } from "./keybindings";

const mount = (html: string) => {
  document.body.innerHTML = html;
  return document.querySelector<HTMLElement>("#target") ?? document.body;
};

const press = (target: EventTarget | null, extra: { isComposing?: boolean } = {}) => ({
  key: "a",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  target,
  ...extra,
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isPageShortcutSuppressed", () => {
  it("lets a key pressed on the page through", () => {
    expect(isPageShortcutSuppressed(press(mount(`<button id="target">Row</button>`)))).toBe(false);
  });

  it.each([
    ["an input", `<input id="target" />`],
    ["a textarea", `<textarea id="target"></textarea>`],
    ["a select", `<select id="target"></select>`],
    ["rich text", `<div contenteditable="true"><p id="target">Hi</p></div>`],
  ])("leaves letters to %s", (_, html) => {
    expect(isPageShortcutSuppressed(press(mount(html)))).toBe(true);
  });

  it("stands down while text is being composed", () => {
    expect(isPageShortcutSuppressed(press(document.body, { isComposing: true }))).toBe(true);
  });

  it.each([
    ["a dialog", `<div role="dialog"><button id="target">OK</button></div>`],
    ["an alert dialog", `<div role="alertdialog"><button id="target">OK</button></div>`],
    ["a modal", `<div aria-modal="true"><button id="target">OK</button></div>`],
    ["a menu", `<div data-slot="menu-popup"><div id="target">Item</div></div>`],
  ])("leaves keys pressed inside %s to it", (_, html) => {
    expect(isPageShortcutSuppressed(press(mount(html)))).toBe(true);
  });

  it.each([
    ["the command palette", `<div data-command-palette="true"></div>`],
    ["the model picker", `<div data-model-picker-content="true"></div>`],
  ])("stands down while %s is open, wherever focus is", (_, html) => {
    mount(html);
    expect(isPageShortcutSuppressed(press(document.body))).toBe(true);
  });
});
