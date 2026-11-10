import { ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";

/** A link out of Phoenix, such as a Notion page, opened in a new tab. Pass it `safeHttpsUrl`'s. */
export function SalesExternalLink(props: { readonly href: string; readonly children: ReactNode }) {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 hover:underline"
    >
      {props.children}
      <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
    </a>
  );
}
