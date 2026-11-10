import { createRowActions, type RowActions } from "@t3tools/client-runtime/sales/row-actions";
import { useState, useSyncExternalStore } from "react";

/** One list's per-row action state (`createRowActions`), rendered again as it changes. */
export function useRowActions<O>(): RowActions<O> {
  const [rows] = useState(createRowActions<O>);
  useSyncExternalStore(rows.subscribe, rows.getVersion);
  return rows;
}
