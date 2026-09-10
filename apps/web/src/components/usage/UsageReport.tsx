import { useMemo, useState } from "react";
import { FolderIcon, MessageSquareIcon, SearchIcon } from "lucide-react";
import { buildUsageReport } from "@t3tools/client-runtime/usage/reports";
import type { MergedUsage } from "@t3tools/shared/usageMerge";
import { formatTokens, formatUsd, formatDateTimeShort } from "@t3tools/shared/usageFormat";
import { ProjectFavicon } from "../ProjectFavicon";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table";
import { Button } from "../ui/button";

const PAGE_SIZE = 50;

export function UsageReport({
  mode,
  merged,
}: {
  readonly mode: "projects" | "sessions";
  readonly merged: MergedUsage;
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("cost");
  const rows = useMemo(
    () =>
      buildUsageReport(merged.sessionUsage, mode)
        .filter((row) =>
          [row.title, row.environmentLabel, ...row.models, row.sessionId ?? ""].some((value) =>
            value.toLowerCase().includes(search.toLowerCase()),
          ),
        )
        .toSorted((a, b) =>
          sort === "tokens"
            ? b.totalTokens - a.totalTokens
            : sort === "activity"
              ? b.lastActivityAt.localeCompare(a.lastActivityAt)
              : b.costUsd - a.costUsd,
        ),
    [merged.sessionUsage, mode, search, sort],
  );
  const recordsWithoutSession = Math.max(
    0,
    merged.records -
      merged.sessionUsage.reduce(
        (sum, session) => sum + session.models.reduce((total, model) => total + model.records, 0),
        0,
      ),
  );
  const [page, setPage] = useState(0);
  const lastPage = Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1);
  const activePage = Math.min(page, lastPage);
  const visible = rows.slice(activePage * PAGE_SIZE, (activePage + 1) * PAGE_SIZE);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">
          Usage by {mode === "projects" ? "project" : "session"}
        </h2>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 rounded-md border px-2 py-1">
            <SearchIcon className="size-3.5 text-muted-foreground" />
            <input
              aria-label={mode === "projects" ? "Search projects" : "Search sessions"}
              placeholder={mode === "projects" ? "Search projects" : "Search sessions"}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
              className="w-36 bg-transparent text-xs outline-none"
            />
          </label>
          <select
            aria-label="Sort usage report"
            className="rounded-md border bg-background px-2 py-1 text-xs"
            value={sort}
            onChange={(event) => {
              setSort(event.target.value);
              setPage(0);
            }}
          >
            <option value="cost">API cost ↓</option>
            <option value="tokens">Tokens ↓</option>
            <option value="activity">Last activity ↓</option>
          </select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Usage during the selected period. API cost is an estimate; subscription charges are
        separate. Unlinked sessions are provider history without a matching Phoenix conversation;
        their usage is included in totals.
      </p>
      {merged.sessionDetailUnavailable.length > 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          Session detail is unavailable from {merged.sessionDetailUnavailable.length}{" "}
          environment(s). Their usage remains in Overview.
        </p>
      )}
      {recordsWithoutSession > 0 && (
        <p className="text-xs text-muted-foreground">
          {recordsWithoutSession.toLocaleString()} usage records have no session detail in this
          report. Their tokens and cost remain included in Overview.
        </p>
      )}
      {rows.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {search ? "No matching results." : "No session detail available for this selection."}
        </p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{mode === "projects" ? "Project" : "Session"}</TableHead>
                <TableHead>Models</TableHead>
                {mode === "projects" && <TableHead className="text-right">Sessions</TableHead>}
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cache read / write</TableHead>
                <TableHead className="text-right">API cost</TableHead>
                <TableHead className="text-right">Last activity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <TableRow key={row.key}>
                  <TableCell className="py-5">
                    <div className="flex items-center gap-3">
                      {row.project ? (
                        <ProjectFavicon
                          environmentId={row.environmentId}
                          cwd={row.project.projectWorkspaceRoot}
                          faviconPath={row.project.projectFaviconPath}
                          className="size-5 shrink-0"
                        />
                      ) : mode === "projects" ? (
                        <FolderIcon className="size-5 shrink-0 text-muted-foreground" />
                      ) : (
                        <MessageSquareIcon className="size-5 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0">
                        <div className="max-w-80 whitespace-normal break-words text-sm">
                          {row.title}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {mode === "sessions" && row.project
                            ? `${row.project.projectTitle} · `
                            : ""}
                          {row.environmentLabel}
                          {row.sessionId ? ` · ${row.sessionId.slice(0, 8)}` : ""}
                          {row.attribution === "ambiguous" ? " · Shared history" : ""}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-60 whitespace-normal text-xs">
                    {row.models.length <= 3 ? (
                      row.models.join(", ")
                    ) : (
                      <details>
                        <summary className="cursor-pointer">
                          {row.models.slice(0, 2).join(", ")} +{row.models.length - 2} models
                        </summary>
                        <div className="mt-2 break-words">{row.models.join(", ")}</div>
                      </details>
                    )}
                  </TableCell>
                  {mode === "projects" && (
                    <TableCell className="text-right tabular-nums">{row.sessions}</TableCell>
                  )}
                  <TableCell className="text-right tabular-nums">
                    {formatTokens(row.totalTokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatTokens(row.cachedInputTokens)} / {formatTokens(row.cacheCreationTokens)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatUsd(row.costUsd)}
                    {row.unpricedRecords > 0 && (
                      <div className="text-xs text-muted-foreground">Some usage unpriced</div>
                    )}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {formatDateTimeShort(
                      row.lastActivityAt,
                      Intl.DateTimeFormat().resolvedOptions().timeZone,
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {lastPage > 0 && (
            <div className="flex items-center justify-end gap-3 text-xs text-muted-foreground">
              <Button
                variant="outline"
                size="sm"
                disabled={activePage === 0}
                onClick={() => setPage(activePage - 1)}
              >
                Previous
              </Button>
              <span>
                {activePage + 1} / {lastPage + 1}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={activePage === lastPage}
                onClick={() => setPage(activePage + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
