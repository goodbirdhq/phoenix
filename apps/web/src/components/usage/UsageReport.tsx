import { useMemo, useState } from "react";
import { FolderIcon, MessageSquareIcon } from "lucide-react";
import { buildUsageReport } from "@t3tools/client-runtime/usage/reports";
import type { MergedUsage } from "@t3tools/shared/usageMerge";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { ProjectFavicon } from "../ProjectFavicon";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table";
import { Button } from "../ui/button";

const PAGE_SIZE = 50;

export function UsageReport({
  mode,
  merged,
}: {
  readonly mode: "projects" | "threads";
  readonly merged: MergedUsage;
}) {
  const rows = useMemo(
    () => buildUsageReport(merged.sessionUsage, mode),
    [merged.sessionUsage, mode],
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
          No session detail available for this selection.
        </p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{mode === "projects" ? "Project" : "Thread / session"}</TableHead>
                <TableHead>Models</TableHead>
                <TableHead className="text-right">Sessions</TableHead>
                <TableHead className="text-right">Tokens</TableHead>
                <TableHead className="text-right">Cache read / write</TableHead>
                <TableHead className="text-right">API cost</TableHead>
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
                          {mode === "threads" && row.project
                            ? `${row.project.projectTitle} · `
                            : ""}
                          {row.environmentLabel}
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
                  <TableCell className="text-right tabular-nums">{row.sessions}</TableCell>
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
