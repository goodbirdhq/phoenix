import { createContext, useContext } from "react";

/** The route owns the queries; its list renders in the shared, collapsible sidebar shell. */
export const PullRequestSidebarSlot = createContext<HTMLDivElement | null>(null);
export function usePullRequestSidebarSlot() {
  return useContext(PullRequestSidebarSlot);
}
