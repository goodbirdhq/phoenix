import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { resolveShortcutCommand, type ShortcutEventLike } from "../../keybindings";

/** The Sales list keys, in footer order, with their Settings labels. */
export const SALES_SHORTCUTS = [
  { command: "sales.next", label: "Sales: Next Item" },
  { command: "sales.previous", label: "Sales: Previous Item" },
  { command: "sales.approve", label: "Sales: Approve Selected Draft" },
  { command: "sales.edit", label: "Sales: Edit Selected Draft" },
] as const satisfies readonly { command: KeybindingCommand; label: string }[];

export type SalesShortcutCommand = (typeof SALES_SHORTCUTS)[number]["command"];

/** The context a Sales list (Outreach, Conversations) resolves its keys in. */
export const SALES_LIST_CONTEXT = { salesListOpen: true } as const;

/**
 * The Sales command a key press asks for. The defaults are plain letters, so they stand down
 * while the person types or has a dialog open.
 */
export function resolveSalesShortcut(
  event: ShortcutEventLike & { target: EventTarget | null },
  keybindings: ResolvedKeybindingsConfig,
): SalesShortcutCommand | null {
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  ) {
    return null;
  }
  if (document.querySelector("[role='dialog'], [role='alertdialog']")) return null;
  const command = resolveShortcutCommand(event, keybindings, { context: SALES_LIST_CONTEXT });
  return SALES_SHORTCUTS.find((shortcut) => shortcut.command === command)?.command ?? null;
}
