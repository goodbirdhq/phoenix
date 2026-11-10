import { salesStatusNotice } from "@t3tools/client-runtime/sales/home";
import type { SalesContactRef, SalesEngineStatus } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import { PageHeading } from "../patterns/PageHeading";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { WorkspacePageContainer } from "../WorkspacePageContainer";

interface ViewRead<Data> {
  readonly status: SalesEngineStatus;
  readonly message: string | null;
  readonly data: Data | null;
  readonly readAt: string | null;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/**
 * The page around one area's engine list: its heading, what to say until the list arrives, and
 * a warning above a list kept from an earlier read when the latest one failed.
 */
export function SalesViewFrame<Data>(props: {
  readonly title: string;
  readonly read: ViewRead<Data> | null;
  /** The stream itself failed, not the engine. */
  readonly failed: boolean;
  readonly description?: (data: Data) => ReactNode;
  readonly actions?: ReactNode;
  readonly children: (data: Data) => ReactNode;
}) {
  const { read } = props;
  const data = read?.data ?? null;
  const notice = read === null ? null : salesStatusNotice(read);
  return (
    <ScrollArea className="min-h-0 flex-1">
      <WorkspacePageContainer>
        <PageHeading
          title={props.title}
          description={data === null ? undefined : props.description?.(data)}
          actions={data === null ? undefined : props.actions}
        />
        {data !== null ? (
          <>
            {notice ? (
              <Alert variant="warning">
                <TriangleAlertIcon />
                <AlertTitle>{notice.title}</AlertTitle>
                <AlertDescription>
                  {notice.description}{" "}
                  {read?.readAt
                    ? `Showing what the engine said at ${timeFormat.format(Date.parse(read.readAt))}.`
                    : null}
                </AlertDescription>
              </Alert>
            ) : null}
            {props.children(data)}
          </>
        ) : (
          <SalesViewEmpty
            title={
              props.failed
                ? `${props.title} is unavailable`
                : (notice?.title ?? `Reading ${props.title.toLowerCase()}…`)
            }
            description={
              props.failed
                ? "This environment's server could not send it. It may need an update."
                : read?.status === "loading"
                  ? ""
                  : (notice?.description ?? "")
            }
            settings={notice?.action === "settings"}
          />
        )}
      </WorkspacePageContainer>
    </ScrollArea>
  );
}

function SalesViewEmpty(props: {
  readonly title: string;
  readonly description: string;
  readonly settings: boolean;
}) {
  const navigate = useNavigate();
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        {props.description ? <EmptyDescription>{props.description}</EmptyDescription> : null}
      </EmptyHeader>
      {props.settings ? (
        <EmptyContent>
          <Button
            variant="outline"
            onClick={() => void navigate({ to: "/settings/integrations", hash: "sales-engine" })}
          >
            Open settings
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

/** An https URL the engine sent, or null; nothing else becomes a link. */
export const safeHttpUrl = (value: string | null) =>
  value !== null && value.startsWith("https://") && URL.canParse(value) ? value : null;

export function ExternalLink(props: {
  readonly href: string;
  readonly label?: string;
  readonly children: ReactNode;
}) {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noreferrer"
      aria-label={props.label}
      className="inline-flex items-center gap-1 hover:underline"
    >
      {props.children}
      <ExternalLinkIcon aria-hidden className="size-3 shrink-0 opacity-60" />
    </a>
  );
}

/** The contact's name, linked to their Notion page, then their account. */
export function SalesContactLine({ contact }: { readonly contact: SalesContactRef }) {
  const name = contact.name ?? contact.email ?? "Unnamed contact";
  const page = safeHttpUrl(contact.notionUrl);
  return (
    <span className="min-w-0 truncate text-sm">
      {page ? <ExternalLink href={page}>{name}</ExternalLink> : name}
      {contact.accountName ? (
        <span className="text-muted-foreground"> · {contact.accountName}</span>
      ) : null}
    </span>
  );
}
