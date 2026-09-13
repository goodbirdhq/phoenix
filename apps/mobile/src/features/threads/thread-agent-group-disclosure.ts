/**
 * A child-agent stack either discloses its unpinned hierarchy or, when every
 * child is already pinned elsewhere, opens the parent session details.
 */
export function resolveThreadAgentGroupPress(canExpand: boolean): "toggle" | "details" {
  return canExpand ? "toggle" : "details";
}
