import type { SalesArea } from "@t3tools/client-runtime/sales/areas";
import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";

import {
  isPageShortcutSuppressed,
  resolveShortcutCommand,
  type PageShortcutEventLike,
} from "../../keybindings";

/**
 * The Sales list keys, in the order the list's footer shows them: `label` names the command in
 * Settings, `hint` in the footer. Moving repeats while the key is held; approving and editing
 * do not.
 */
export const SALES_SHORTCUTS = [
  { command: "sales.next", label: "Sales: Next Item", hint: "next", repeats: true },
  { command: "sales.previous", label: "Sales: Previous Item", hint: "previous", repeats: true },
  {
    command: "sales.approve",
    label: "Sales: Approve Selected Draft",
    hint: "approve",
    repeats: false,
  },
  { command: "sales.edit", label: "Sales: Edit Selected Draft", hint: "edit", repeats: false },
] as const satisfies readonly {
  command: KeybindingCommand;
  label: string;
  hint: string;
  repeats: boolean;
}[];

export type SalesShortcutCommand = (typeof SALES_SHORTCUTS)[number]["command"];

/** The context a Sales list (Outreach, Conversations) resolves its keys in. */
export const SALES_LIST_CONTEXT = { salesListOpen: true } as const;

/** Whether a Sales area's screen is a list that runs these keys. */
export const isSalesListArea = (area: SalesArea | undefined) =>
  area === "outreach" || area === "conversations";

/** The Sales command a key press asks for, or null when the page should leave it alone. */
export function resolveSalesShortcut(
  event: PageShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
): SalesShortcutCommand | null {
  if (isPageShortcutSuppressed(event)) return null;
  const command = resolveShortcutCommand(event, keybindings, { context: SALES_LIST_CONTEXT });
  const shortcut = SALES_SHORTCUTS.find((entry) => entry.command === command);
  if (shortcut === undefined || (event.repeat === true && !shortcut.repeats)) return null;
  return shortcut.command;
}
