import {
  ActivityIcon,
  type LucideIcon,
  MegaphoneIcon,
  MessagesSquareIcon,
  SendIcon,
  SquareCheckBigIcon,
  ZapIcon,
} from "lucide-react";

/**
 * The Sales areas with a screen, in sidebar order. An entry here is what the route accepts, the
 * sidebar lists and Home links to; `SalesPage` then asks for its screen by key. Counts come from
 * the Home summary where it has an area with the same key.
 *
 * The route validates against this list, so it stays free of the screens themselves: importing
 * them here would pull them out of the route's lazy chunk.
 */
export const SALES_AREAS = [
  { key: "outreach", label: "Outreach", icon: SendIcon },
  { key: "autopilot", label: "Autopilot", icon: ZapIcon },
  { key: "todo", label: "To do", icon: SquareCheckBigIcon },
  { key: "conversations", label: "Conversations", icon: MessagesSquareIcon },
  { key: "campaigns", label: "Campaigns", icon: MegaphoneIcon },
  { key: "health", label: "Health", icon: ActivityIcon },
] as const satisfies ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly icon: LucideIcon;
}>;

export type SalesArea = (typeof SALES_AREAS)[number]["key"];

export const isSalesArea = (key: unknown): key is SalesArea =>
  SALES_AREAS.some((area) => area.key === key);
