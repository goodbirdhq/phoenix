import type { SalesArea } from "@t3tools/client-runtime/sales/areas";
import {
  buildSalesHome,
  engineDayNote,
  lookItemView,
  salesStatusNotice,
  type SalesHome,
  type SalesStatusNotice,
} from "@t3tools/client-runtime/sales/home";
import { salesTime, staleReadNote } from "@t3tools/client-runtime/sales/time";
import type { EnvironmentId, SalesLookItem, SalesSnapshot } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { ChevronRightIcon, CircleCheckIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { type ComponentType, useState } from "react";

import { isElectron } from "../../env";
import { useNowMs } from "../../hooks/useNowMinute";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { salesEnvironment, useSalesState, useSalesTarget } from "../../state/sales";
import { useAtomCommand } from "../../state/use-atom-command";
import { PageHeading } from "../patterns/PageHeading";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SALES_AREAS } from "./areas";
import { SalesAutopilot } from "./SalesAutopilot";
import { SalesCampaigns } from "./SalesCampaigns";
import { SalesConversations } from "./SalesConversations";
import { SalesExternalLink } from "./SalesExternalLink";
import { SalesHealth } from "./SalesHealth";
import { SalesOutreach } from "./SalesOutreach";
import { SalesTodo } from "./SalesTodo";

/** Each area's screen, given the same props. */
const AREA_PAGES: Record<
  SalesArea,
  ComponentType<{
    readonly environmentId: EnvironmentId;
    readonly baseUrl: string;
    readonly canAct: boolean;
    /** The selected item from the URL, in the area's own terms. */
    readonly selected: string | undefined;
    readonly onSelect: (item: string) => void;
  }>
> = {
  outreach: SalesOutreach,
  autopilot: SalesAutopilot,
  todo: SalesTodo,
  conversations: SalesConversations,
  campaigns: SalesCampaigns,
  health: SalesHealth,
};

const NOT_CONFIGURED: SalesStatusNotice = {
  title: "Sales is not set up",
  description:
    "Add the sales engine's URL and read token in Settings › Integrations for an environment.",
  action: "settings",
};

export function SalesPage() {
  const { environment: requested, area, item } = useSearch({ from: "/sales" });
  const { isReady, target, canAct } = useSalesTarget(requested);
  const navigate = useNavigate();
  const select = (next: string) =>
    void navigate({
      to: "/sales",
      search: {
        ...(requested ? { environment: requested } : {}),
        ...(area ? { area } : {}),
        item: next,
      },
      replace: true,
    });
  const baseUrl = target?.serverConfig?.settings.salesEngine.baseUrl ?? "";
  const AreaPage = area ? AREA_PAGES[area] : null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Sales breadcrumb">
            <WorkspaceBreadcrumbItem current>Sales</WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator className="hidden md:flex" />
            <WorkspaceBreadcrumbItem className="hidden md:flex">
              {SALES_AREAS.find((entry) => entry.key === area)?.label ?? "Home"}
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        {target && AreaPage ? (
          <AreaPage
            key={target.environmentId}
            environmentId={target.environmentId}
            baseUrl={baseUrl}
            canAct={canAct}
            selected={item}
            onSelect={select}
          />
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <WorkspacePageContainer>
              {target ? (
                <SalesHomeView key={target.environmentId} environmentId={target.environmentId} />
              ) : isReady ? (
                <SalesNotice notice={NOT_CONFIGURED} />
              ) : (
                <SalesNotice
                  notice={{ title: "Loading environments…", description: "", action: null }}
                />
              )}
            </WorkspacePageContainer>
          </ScrollArea>
        )}
      </div>
    </SidebarInset>
  );
}

function SalesHomeView({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const state = useSalesState(environmentId);
  const refreshCommand = useAtomCommand(salesEnvironment.refresh, { label: "refresh Sales" });
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshCommand({ environmentId, input: {} });
    } finally {
      setRefreshing(false);
    }
  };
  const snapshot = Option.getOrNull(state.snapshot);

  if (snapshot === null) {
    return (
      <SalesNotice
        notice={
          state.status === "cached" || Option.isSome(state.error)
            ? {
                title: "Sales is unavailable",
                description:
                  Option.getOrNull(state.error) ?? "This environment is offline. Reconnect it.",
                action: null,
              }
            : { title: "Loading Sales…", description: "", action: null }
        }
      />
    );
  }

  const notice = salesStatusNotice(snapshot);
  if (snapshot.summary === null) {
    return (
      <SalesNotice notice={notice ?? NOT_CONFIGURED} onRetry={refresh} retrying={refreshing} />
    );
  }

  return (
    <SalesHomeContent
      home={buildSalesHome(snapshot.summary)}
      snapshot={snapshot}
      notice={notice}
      offline={state.status !== "live"}
      refreshing={refreshing}
      onRefresh={refresh}
    />
  );
}

const viewerTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function SalesHomeContent({
  home,
  snapshot,
  notice,
  offline,
  refreshing,
  onRefresh,
}: {
  readonly home: SalesHome;
  readonly snapshot: SalesSnapshot;
  readonly notice: SalesStatusNotice | null;
  readonly offline: boolean;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}) {
  const navigate = useNavigate();
  const { environment } = useSearch({ from: "/sales" });
  const now = useNowMs();
  // "N min ago" stands still without fresh reads, so a stale summary says when it was read.
  const updated =
    snapshot.summaryReadAt === null
      ? null
      : offline
        ? (salesTime(snapshot.summaryReadAt, now)?.local ?? null)
        : formatRelativeTimeLabel(snapshot.summaryReadAt);
  const summary = snapshot.summary;
  return (
    <>
      <PageHeading
        title={home.headline}
        description={[
          updated ? `Updated ${updated}` : null,
          summary ? engineDayNote(summary, viewerTimeZone) : null,
          offline ? "Offline" : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <Button size="sm" variant="outline" disabled={refreshing} onClick={onRefresh}>
            <RefreshCwIcon aria-hidden />
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />

      {notice ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>
            {notice.description} {staleReadNote(snapshot.summaryReadAt, now)}
          </AlertDescription>
          {notice.action === "settings" ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => void navigate({ to: "/settings/integrations", hash: "sales-engine" })}
            >
              Open settings
            </Button>
          ) : null}
        </Alert>
      ) : null}

      <ul aria-label="Work areas" className="divide-y rounded-lg border">
        {home.areas.map((area) => (
          <li key={area.key} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <div className="min-w-40 flex-1">
              <button
                type="button"
                className="inline-flex items-center gap-1 text-sm font-medium hover:underline"
                onClick={() =>
                  void navigate({
                    to: "/sales",
                    search: { ...(environment ? { environment } : {}), area: area.key },
                  })
                }
              >
                {area.label}
                <ChevronRightIcon aria-hidden className="size-3.5" />
              </button>
              <p className="text-xs text-muted-foreground">{area.status}</p>
            </div>
            {area.figures.length > 0 ? (
              <dl className="flex gap-5">
                {area.figures.map((figure) => (
                  <div key={figure.label} className="flex flex-col">
                    <dt className="text-xs text-muted-foreground">{figure.label}</dt>
                    <dd className="text-sm tabular-nums">{figure.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <div className="flex w-10 justify-end">
              {area.count > 0 ? (
                <Badge variant="warning" aria-label={`${area.count} need you`}>
                  {area.count}
                </Badge>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        {home.health.ok ? (
          <CircleCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
        ) : (
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
        )}
        <button
          type="button"
          className="text-left hover:underline"
          onClick={() =>
            void navigate({
              to: "/sales",
              search: { ...(environment ? { environment } : {}), area: "health" },
            })
          }
        >
          {home.health.line}
        </button>
      </p>

      {summary && summary.needsALook.items.length > 0 ? (
        <NeedsALook items={summary.needsALook.items} />
      ) : null}
    </>
  );
}

const LOOK_LIMIT = 5;

/** Subjects and reasons can hold a stranger's words: rendered as text only. */
function NeedsALook({ items }: { readonly items: ReadonlyArray<SalesLookItem> }) {
  return (
    <section aria-label="Needs a look" className="space-y-2">
      <h2 className="text-sm font-medium">Needs a look</h2>
      <ul className="space-y-1.5">
        {items.slice(0, LOOK_LIMIT).map((item) => {
          const view = lookItemView(item);
          return (
            <li
              key={[item.at, item.what, item.who, item.subject, item.why].join("\u0000")}
              className="text-xs"
            >
              <span className="text-foreground">{view.title}</span>
              {view.why ? <span className="text-muted-foreground"> — {view.why}</span> : null}
              {view.notionUrl ? (
                <span className="text-muted-foreground">
                  {" · "}
                  <SalesExternalLink href={view.notionUrl}>Open in Notion</SalesExternalLink>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function SalesNotice({
  notice,
  onRetry,
  retrying = false,
}: {
  readonly notice: SalesStatusNotice;
  readonly onRetry?: () => void;
  readonly retrying?: boolean;
}) {
  const navigate = useNavigate();
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{notice.title}</EmptyTitle>
        {notice.description ? <EmptyDescription>{notice.description}</EmptyDescription> : null}
      </EmptyHeader>
      {notice.action === "settings" ? (
        <EmptyContent>
          <Button
            variant="outline"
            onClick={() => void navigate({ to: "/settings/integrations", hash: "sales-engine" })}
          >
            Open settings
          </Button>
        </EmptyContent>
      ) : notice.action === "retry" && onRetry ? (
        <EmptyContent>
          <Button variant="outline" disabled={retrying} onClick={onRetry}>
            {retrying ? "Trying…" : "Try again"}
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
