import { ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";

/** A link the engine handed over, kept only when it is a well-formed https URL. */
export const safeHttpUrl = (value: string | null) =>
  value !== null && value.startsWith("https://") && URL.canParse(value) ? value : null;

/** A link out of Phoenix, such as a Notion page, opened in a new tab. */
export function SalesExternalLink(props: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 hover:underline"
    >
      {props.children}
      <ExternalLinkIcon aria-hidden className="size-3 text-muted-foreground" />
    </a>
  );
}
