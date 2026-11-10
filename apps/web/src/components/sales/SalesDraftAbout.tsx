import { safeHttpUrl } from "@t3tools/client-runtime/sales/links";
import type { SalesQueueItemDetail } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { SalesExternalLink } from "./SalesExternalLink";

/**
 * Who a draft is to and where it came from, from what the engine carries. Shows only what is
 * known; a section with nothing in it is left out.
 */
export function SalesDraftAbout({ detail }: { readonly detail: SalesQueueItemDetail }) {
  const { contact } = detail;
  const linkedin = safeHttpUrl(contact.linkedinUrl);
  const contactPage = safeHttpUrl(contact.notionUrl);
  const rowPage = safeHttpUrl(detail.notionUrl);
  const person = [contact.name, contact.accountName].filter(Boolean).join(" · ");
  const hasPerson =
    person !== "" ||
    contact.effectiveTimeZone !== null ||
    linkedin !== null ||
    contactPage !== null;

  if (!hasPerson && detail.campaign === null && rowPage === null) return null;
  return (
    <aside
      aria-label="About this draft"
      className="grid content-start gap-4 border-t pt-4 @3xl:border-t-0 @3xl:border-l @3xl:pt-0 @3xl:pl-6"
    >
      {hasPerson ? (
        <AboutSection title="Person">
          {person ? <p>{person}</p> : null}
          {contact.effectiveTimeZone ? (
            <p className="text-xs text-muted-foreground">
              Sends timed in {contact.effectiveTimeZone}
            </p>
          ) : null}
          {linkedin ? <SalesExternalLink href={linkedin}>LinkedIn</SalesExternalLink> : null}
          {contactPage ? (
            <SalesExternalLink href={contactPage}>Contact in Notion</SalesExternalLink>
          ) : null}
        </AboutSection>
      ) : null}
      {detail.campaign !== null || rowPage !== null ? (
        <AboutSection title="Campaign">
          {detail.campaign ? <p>{detail.campaign}</p> : null}
          {rowPage ? (
            <SalesExternalLink href={rowPage}>Activity in Notion</SalesExternalLink>
          ) : null}
        </AboutSection>
      ) : null}
    </aside>
  );
}

function AboutSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="grid gap-1">
      <h3 className="text-xs text-muted-foreground">{title}</h3>
      <div className="grid gap-1 text-sm">{children}</div>
    </section>
  );
}
