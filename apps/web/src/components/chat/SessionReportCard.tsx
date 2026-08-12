import { memo, useState } from "react";
import type {
  ScopedThreadRef,
  SessionReportArtifact,
  SessionReportStatus,
} from "@t3tools/contracts";
import type { SessionReport } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";

const STATUS_BADGE_VARIANT: Record<SessionReportStatus, "success" | "error" | "warning"> = {
  success: "success",
  failure: "error",
  partial: "warning",
};

const STATUS_LABEL: Record<SessionReportStatus, string> = {
  success: "Success",
  failure: "Failure",
  partial: "Partial",
};

const ARTIFACT_KIND_LABEL: Record<SessionReportArtifact["kind"], string> = {
  file: "File",
  branch: "Branch",
  url: "Link",
  other: "Other",
};

export const SessionReportCard = memo(function SessionReportCard({
  report,
  cwd,
  threadRef,
}: {
  report: SessionReport;
  cwd: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const lineCount = report.summary.split("\n").length;
  const canCollapse = report.summary.length > 900 || lineCount > 20;

  return (
    <div className="rounded-[24px] border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={STATUS_BADGE_VARIANT[report.status]}>{STATUS_LABEL[report.status]}</Badge>
        {/* A report Phoenix wrote for a session that died before reporting must
            never be mistaken for the agent's own account of its work. */}
        {report.origin === "system" ? (
          <Badge
            variant="outline"
            title="Phoenix wrote this report because the session ended without posting one."
          >
            Auto-generated
          </Badge>
        ) : null}
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {report.title}
        </p>
      </div>
      <div className="mt-4">
        <div className={cn("relative", canCollapse && !expanded && "max-h-52 overflow-hidden")}>
          <ChatMarkdown text={report.summary} cwd={cwd} threadRef={threadRef} isStreaming={false} />
          {canCollapse && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-3 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Collapse summary" : "Expand summary"}
            </Button>
          </div>
        ) : null}
      </div>
      {report.artifacts.length > 0 ? (
        <ul className="mt-3 space-y-1 border-t border-border/60 pt-3 text-xs">
          {report.artifacts.map((artifact) => (
            <li
              key={`${artifact.kind}:${artifact.value}`}
              className="flex min-w-0 items-center gap-1.5"
            >
              <span className="shrink-0 text-muted-foreground/60">
                {ARTIFACT_KIND_LABEL[artifact.kind]}
              </span>
              {artifact.kind === "url" ? (
                <a
                  href={artifact.value}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="min-w-0 truncate text-foreground underline-offset-2 hover:underline"
                >
                  {artifact.label ?? artifact.value}
                </a>
              ) : (
                <span className="min-w-0 truncate font-mono text-foreground/80">
                  {artifact.label ?? artifact.value}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
});
