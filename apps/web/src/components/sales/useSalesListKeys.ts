import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef } from "react";

import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  resolveSalesShortcut,
  SALES_LIST_CONTEXT,
  type SalesShortcutCommand,
} from "./salesShortcuts";

export type SalesListKeys = Partial<Record<SalesShortcutCommand, () => void>>;

/**
 * Runs a Sales list's commands from their bindings (J and K move, A approves the open draft,
 * E edits it, by default; rebindable in Settings › Keybindings).
 */
export function useSalesListKeys(keys: SalesListKeys): void {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const current = useRef(keys);
  useEffect(() => {
    current.current = keys;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveSalesShortcut(event, keybindings);
      const action = command === null ? undefined : current.current[command];
      if (action === undefined) return;
      event.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);
}

/** Looks up a Sales command's current key label; null when it is unbound. */
export function useSalesShortcutLabel(): (command: SalesShortcutCommand) => string | null {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  return (command) =>
    shortcutLabelForCommand(keybindings, command, { context: SALES_LIST_CONTEXT });
}
