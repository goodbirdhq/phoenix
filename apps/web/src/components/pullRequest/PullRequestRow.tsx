import { ProjectFavicon } from "../ProjectFavicon";
import { EnvironmentIcon } from "../environments/EnvironmentIcon";
import { SearchIcon, FolderGit2Icon, ArrowUpRightIcon, MoreHorizontalIcon } from "lucide-react";
import { memo, type RefCallback } from "react";

import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestChecksPopover } from "./PullRequestChecksPopover";
import { pullRequestLabelColor, type EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { openOnHostLabel, showPullRequestLinkContextMenu } from "./pullRequestLinkContextMenu";
import {
  PullRequestActorLabel,
  PullRequestDiffStat,
  PullRequestMetaLine,
  PullRequestStateGlyph,
  resolvePullRequestState,
} from "./pullRequestPresentation";

function PullRequestRowLabels({ labels }: { labels: EnvironmentPullRequestEntry["labels"] }) {
  const label = labels[0];
  if (!label) return null;
  const dot = pullRequestLabelColor(label.color);
  return (
    <span className="inline-flex max-w-40 min-w-0 items-center gap-1 rounded-full border border-border/70 bg-muted/40 py-0 pl-1 pr-1.5 text-[10px] leading-3.5 text-muted-foreground">
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full bg-muted-foreground"
        {...(dot ? { style: { backgroundColor: dot } } : {})}
      />
      <span className="truncate">{label.name}</span>
      {labels.length > 1 ? <span className="shrink-0">+{labels.length - 1}</span> : null}
    </span>
  );
}

function PullRequestRowImpl({
  entry,
  selected,
  showProjectTitle,
  showProvider,
  environmentLabel,
  matchedElsewhere,
  projectIcon,
  statsKey,
  statsRef,
  onSelect,
}: {
  entry: EnvironmentPullRequestEntry;
  selected: boolean;
  showProjectTitle: boolean;
  /** Only when the list spans more than one host, where the repository alone is ambiguous. */
  showProvider: boolean;
  /** Names the server this row was read from, where the list spans more than one. */
  environmentLabel?: string;
  /**
   * A search found this, but in something the row does not show — a description, a comment, a
   * commit message. Saying so is the difference between a result and an apparently random row.
   */
  matchedElsewhere?: boolean;
  /** Used by the list's shared visibility observer to defer optional line-count reads. */
  projectIcon?: { workspaceRoot: string; faviconPath: string | null };
  statsKey?: string;
  statsRef?: RefCallback<HTMLButtonElement>;
  onSelect: (entry: EnvironmentPullRequestEntry) => void;
}) {
  const state = resolvePullRequestState(entry);
  const { Icon, providerName } = getSourceControlPresentationForKind(entry.provider);
  return (
    <div
      className={cn(
        "group/pr-row relative grid w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-2.5 rounded-lg px-2.5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        // Offscreen rows are skipped for style, layout and paint: a long list costs what the
        // viewport shows, not what the pages have loaded. The intrinsic size keeps the
        // scrollbar honest while a row is skipped.
        "[contain-intrinsic-block-size:82px] [content-visibility:auto]",
        selected ? "bg-white dark:bg-zinc-800" : "hover:bg-white dark:hover:bg-zinc-800",
      )}
    >
      <button
        ref={statsRef}
        data-pull-request-stats-key={statsKey}
        type="button"
        aria-current={selected ? "true" : undefined}
        aria-label={`${entry.title}, ${entry.repository} #${entry.number}, ${state.label}`}
        onClick={() => onSelect(entry)}
        className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <span className="pointer-events-none relative flex size-[30px] shrink-0 items-center justify-center rounded-full border border-border bg-background">
        {projectIcon?.faviconPath ? (
          <ProjectFavicon
            environmentId={entry.environmentId}
            cwd={projectIcon.workspaceRoot}
            faviconPath={projectIcon.faviconPath}
            className="size-[18px]"
            fallbackIcon={FolderGit2Icon}
          />
        ) : (
          <FolderGit2Icon aria-hidden className="size-[18px] text-muted-foreground" />
        )}
        <span className="absolute -bottom-1 -right-1 rounded-full bg-background p-0.5">
          <PullRequestStateGlyph
            state={entry.state}
            isDraft={entry.isDraft}
            mergeability={entry.mergeability}
            baseBranch={entry.baseBranch}
            className="size-3"
          />
        </span>
      </span>
      <span className="pointer-events-none relative grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1">
        <span className="col-start-1 row-start-1 block truncate text-sm font-medium text-foreground">
          {entry.title}
        </span>
        <span className="relative col-start-2 row-start-1 flex w-12 justify-end text-[11px] text-muted-foreground tabular-nums">
          <span className="group-hover/pr-row:invisible group-focus-within/pr-row:invisible">
            {formatRelativeTimeLabel(entry.updatedAt)}
          </span>
          <span className="pointer-events-auto absolute inset-0 flex justify-end gap-1 opacity-0 group-hover/pr-row:opacity-100 group-focus-within/pr-row:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={openOnHostLabel(entry.provider)}
                    onClick={() => void readLocalApi()?.shell.openExternal(entry.url)}
                    className="flex size-5 items-center justify-center rounded hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <ArrowUpRightIcon className="size-3.5" />
                  </button>
                }
              />
              <TooltipPopup>{openOnHostLabel(entry.provider)}</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Actions for #${entry.number}`}
                    onClick={(event) => {
                      const bounds = event.currentTarget.getBoundingClientRect();
                      void showPullRequestLinkContextMenu({
                        url: entry.url,
                        openLabel: openOnHostLabel(entry.provider),
                        position: { x: bounds.left, y: bounds.bottom },
                      });
                    }}
                    className="flex size-5 items-center justify-center rounded hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <MoreHorizontalIcon className="size-3.5" />
                  </button>
                }
              />
              <TooltipPopup>Pull request actions</TooltipPopup>
            </Tooltip>
          </span>
        </span>
        <PullRequestMetaLine className="@container/pr-row-meta col-span-2 col-start-1 row-start-2 overflow-hidden text-xs text-muted-foreground">
          {matchedElsewhere ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="flex min-w-6 items-center gap-1 overflow-hidden rounded-full border border-border/60 px-1 text-[10px]" />
                }
              >
                <span className="sr-only">matched in the description</span>
                <SearchIcon aria-hidden className="size-3 shrink-0" />
                <span aria-hidden className="hidden truncate @xs/pr-row-meta:block">
                  matched in the description
                </span>
              </TooltipTrigger>
              <TooltipPopup side="top">Matched in the description</TooltipPopup>
            </Tooltip>
          ) : null}
          <span className="flex shrink-0 items-center gap-1">
            {showProvider ? (
              <Tooltip>
                <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
                  <Icon aria-label={providerName} className="size-3" />
                </TooltipTrigger>
                <TooltipPopup>{providerName}</TooltipPopup>
              </Tooltip>
            ) : null}
            {/* The number carries the link, here as much as on the detail: a right-click on it
                copies the pull request's own address rather than opening the editing menu. */}
            <button
              type="button"
              onClick={() => onSelect(entry)}
              className="pointer-events-auto rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void showPullRequestLinkContextMenu({
                  url: entry.url,
                  openLabel: openOnHostLabel(entry.provider),
                  position: { x: event.clientX, y: event.clientY },
                });
              }}
            >
              #{entry.number}
            </button>
          </span>
          {showProjectTitle ? <span className="truncate">{entry.repository}</span> : null}
          {environmentLabel ? (
            <span className="flex min-w-0 max-w-36 items-center gap-1">
              <EnvironmentIcon environmentId={entry.environmentId} />
              <span className="truncate">{environmentLabel}</span>
            </span>
          ) : null}
          <PullRequestActorLabel
            actor={entry.author}
            className="min-w-4 max-w-40"
            labelClassName="sr-only @xs/pr-row-meta:not-sr-only @xs/pr-row-meta:truncate"
          />
          {entry.labels.length > 0 ? <PullRequestRowLabels labels={entry.labels} /> : null}
        </PullRequestMetaLine>
        <span className="col-start-1 row-start-3 flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] text-muted-foreground">
          <span className={cn("shrink-0", state.toneClassName)}>{state.label}</span>
          {/* Only a verdict somebody has actually given: "review required" is the absence of
              one, and saying so on every unreviewed row would say nothing. */}
          {entry.reviewDecision === "approved" || entry.reviewDecision === "changes-requested" ? (
            <span
              className={cn(
                "min-w-0 truncate",
                entry.reviewDecision === "approved"
                  ? "text-emerald-600/90 dark:text-emerald-400/80"
                  : "text-amber-600/90 dark:text-amber-400/80",
              )}
            >
              {entry.reviewDecision === "approved" ? "Approved" : "Changes requested"}
            </span>
          ) : null}
          {entry.checksState === undefined ? null : (
            <PullRequestChecksPopover
              showLabel
              className="pointer-events-auto"
              checksState={entry.checksState}
              environmentId={entry.environmentId}
              reference={{
                projectId: entry.projectId,
                repository: entry.repository,
                number: entry.number,
              }}
            />
          )}
        </span>
        {entry.additions === 0 && entry.deletions === 0 ? (
          <span
            aria-label="Line counts unavailable"
            className="col-start-2 row-start-3 text-right text-[11px] text-muted-foreground"
          >
            —
          </span>
        ) : (
          <PullRequestDiffStat
            additions={entry.additions}
            deletions={entry.deletions}
            className="col-start-2 row-start-3 justify-self-end text-[11px]"
          />
        )}
      </span>
    </div>
  );
}

/**
 * Memoized: the list re-renders on every keystroke of a search and every status poll, and a
 * row whose entry, selection and match state are unchanged has nothing new to say. Effective
 * because the route hands it a stable `onSelect`.
 */
export const PullRequestRow = memo(PullRequestRowImpl);
