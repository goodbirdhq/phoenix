import { useSyncExternalStore } from "react";

/** A command the open Sales page offers the command palette, such as approving its draft. */
export interface SalesPaletteCommand {
  readonly id: string;
  readonly title: string;
  readonly keywords: ReadonlyArray<string>;
  /** The key label shown beside it; null when the command is unbound. */
  readonly shortcut?: string | null;
  /** `openedAt`: when the palette opened, on `performance.now()`'s clock. */
  readonly run: (openedAt: number) => void;
}

let current: ReadonlyArray<SalesPaletteCommand> = [];
const listeners = new Set<() => void>();

/** The page sets its commands while mounted and clears them when it goes. */
export function setSalesPaletteCommands(commands: ReadonlyArray<SalesPaletteCommand>): void {
  current = commands;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useSalesPaletteCommands(): ReadonlyArray<SalesPaletteCommand> {
  return useSyncExternalStore(subscribe, () => current);
}
