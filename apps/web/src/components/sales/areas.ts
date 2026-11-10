import {
  SALES_AREA_KEYS,
  SALES_AREA_LABELS,
  type SalesArea,
} from "@t3tools/client-runtime/sales/areas";
import {
  ActivityIcon,
  type LucideIcon,
  MegaphoneIcon,
  MessagesSquareIcon,
  SendIcon,
  SquareCheckBigIcon,
  ZapIcon,
} from "lucide-react";

/** How the web client shows each area: its icon, and what else finds it in the command palette. */
const AREA_CHROME: Record<
  SalesArea,
  { readonly icon: LucideIcon; readonly searchTerms: ReadonlyArray<string> }
> = {
  outreach: { icon: SendIcon, searchTerms: ["drafts", "approve", "queue", "emails"] },
  autopilot: { icon: ZapIcon, searchTerms: ["sends", "today", "scheduled", "chases", "paused"] },
  todo: { icon: SquareCheckBigIcon, searchTerms: ["todo", "tasks", "linkedin", "connect"] },
  conversations: { icon: MessagesSquareIcon, searchTerms: ["replies", "answers", "inbox"] },
  campaigns: { icon: MegaphoneIcon, searchTerms: ["funnel", "replies", "steps"] },
  health: { icon: ActivityIcon, searchTerms: ["mailboxes", "engine", "bounces", "sync"] },
};

/**
 * The Sales areas with a screen, in sidebar order. An entry here is what the sidebar lists, Home
 * links to and the command palette opens; `SalesPage` then asks for its screen by key. Counts
 * come from the Home summary where it has an area with the same key.
 *
 * The route validates against `isSalesArea`, so this stays free of the screens themselves:
 * importing them here would pull them out of the route's lazy chunk.
 */
export const SALES_AREAS = SALES_AREA_KEYS.map((key) => ({
  key,
  label: SALES_AREA_LABELS[key],
  ...AREA_CHROME[key],
}));
