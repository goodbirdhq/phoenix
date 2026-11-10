import { salesStatusNotice } from "@t3tools/client-runtime/sales/home";
import { safeHttpUrl } from "@t3tools/client-runtime/sales/links";
import { staleReadNote } from "@t3tools/client-runtime/sales/time";
import type { SalesContactRef, SalesEngineStatus } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useNowMs } from "../../hooks/useNowMinute";
import { PageHeading } from "../patterns/PageHeading";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { SalesExternalLink } from "./SalesExternalLink";

interface ViewRead<Data> {
  readonly status: SalesEngineStatus;
  readonly message: string | null;
  readonly data: Data | null;
  readonly readAt: string | null;
}

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
  const data = props.read?.data ?? null;
  return (
    <SalesViewPage
      title={props.title}
      description={data === null ? undefined : props.description?.(data)}
      actions={data === null ? undefined : props.actions}
    >
      <SalesViewRead name={props.title} read={props.read} failed={props.failed}>
        {props.children}
      </SalesViewRead>
    </SalesViewPage>
  );
}

/** An area's page: its heading over whatever it lists. */
export function SalesViewPage(props: {
  readonly title: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <WorkspacePageContainer>
        <PageHeading title={props.title} description={props.description} actions={props.actions} />
        {props.children}
      </WorkspacePageContainer>
    </ScrollArea>
  );
}

/**
 * One engine list on a page: the list, with a warning above it when it was kept from an earlier
 * read, or what to say until it arrives. `inline` says that in a line, for a page of several.
 */
export function SalesViewRead<Data>(props: {
  readonly name: string;
  readonly read: ViewRead<Data> | null;
  /** The stream itself failed, not the engine. */
  readonly failed: boolean;
  readonly inline?: boolean;
  readonly children: (data: Data) => ReactNode;
}) {
  const { read } = props;
  const notice = read === null ? null : salesStatusNotice(read);
  const now = useNowMs();
  if (read !== null && read.data !== null) {
    return (
      <>
        {notice ? (
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertTitle>{notice.title}</AlertTitle>
            <AlertDescription>
              {notice.description} {staleReadNote(read.readAt, now)}
            </AlertDescription>
          </Alert>
        ) : null}
        {props.children(read.data)}
      </>
    );
  }
  const title = props.failed
    ? `${props.name} is unavailable`
    : (notice?.title ?? `Reading ${props.name.toLowerCase()}…`);
  const description = props.failed
    ? "This environment's server could not send it. It may need an update."
    : read?.status === "loading"
      ? ""
      : (notice?.description ?? "");
  return props.inline ? (
    <p className="text-sm text-muted-foreground">{[title, description].join(" ").trim()}</p>
  ) : (
    <SalesViewEmpty
      title={title}
      description={description}
      settings={notice?.action === "settings"}
    />
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

/** The contact's name, linked to their Notion page, then their account. */
export function SalesContactLine({ contact }: { readonly contact: SalesContactRef }) {
  const name = contact.name ?? contact.email ?? "Unnamed contact";
  const page = safeHttpUrl(contact.notionUrl);
  return (
    <span className="min-w-0 truncate text-sm">
      {page ? <SalesExternalLink href={page}>{name}</SalesExternalLink> : name}
      {contact.accountName ? (
        <span className="text-muted-foreground"> · {contact.accountName}</span>
      ) : null}
    </span>
  );
}
