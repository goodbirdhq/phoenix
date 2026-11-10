import { useEffect, useRef } from "react";

export interface SalesListKeys {
  readonly next: () => void;
  readonly previous: () => void;
  readonly approve?: () => void;
  readonly edit?: () => void;
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * J and K move through a Sales list, A approves the open draft, E edits it. Plain letters, so
 * they stand down while the person types, holds a modifier, or has a dialog open.
 *
 * Not yet in the keybinding registry (`src/keybindings.ts`), so not rebindable: that needs new
 * `KeybindingCommand`s in contracts, server defaults, a `when` context for the Sales page, and
 * settings labels. Move them there when that lands.
 */
export function useSalesListKeys(keys: SalesListKeys): void {
  const current = useRef(keys);
  useEffect(() => {
    current.current = keys;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (
        isTyping(event.target) ||
        document.querySelector("[role='dialog'], [role='alertdialog']")
      ) {
        return;
      }
      const action =
        event.key === "j"
          ? current.current.next
          : event.key === "k"
            ? current.current.previous
            : event.key === "a"
              ? current.current.approve
              : event.key === "e"
                ? current.current.edit
                : undefined;
      if (action === undefined) return;
      event.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
