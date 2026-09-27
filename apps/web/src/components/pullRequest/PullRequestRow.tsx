import { ProjectFavicon } from "../ProjectFavicon";
import { EnvironmentIcon } from "../environments/EnvironmentIcon";
import { SearchIcon, FolderGit2Icon } from "lucide-react";
import { PullRequestStackPopover } from "./PullRequestStackPopover";
import { memo, type RefCallback } from "react";

import { cn } from "~/lib/utils";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestChecksPopover } from "./PullRequestChecksPopover";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { openOnHostLabel, showPullRequestLinkContextMenu } from "./pullRequestLinkContextMenu";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowAuthor,
  PullRequestRowLines,
} from "./PullRequestListRow";
import {
  PullRequestDiffStat,
  PullRequestConflictGlyph,
  PullRequestLabelChip,
  PullRequestReviewDecisionGlyph,
  PullRequestStateGlyph,
  resolvePullRequestConflict,
  resolvePullRequestState,
} from "./pullRequestPresentation";

/**
 * Each slot past the first only appears once the meta line is wide enough to hold it, so a
 * narrow row shows one label and a "+N" while a wide one spreads out up to three. The "+N"
 * rides on whichever pill is the last visible one, and is hidden as soon as the next slot shows.
 */
// Each slot's pill appears at a wider row, and its overflow count yields to the next slot.
const LABEL_SLOTS = [
  { overflow: "@xl/pr-row-meta:hidden" },
  { overflow: "@3xl/pr-row-meta:hidden" },
  { overflow: "" },
] as const;

function PullRequestRowLabels({ labels }: { labels: EnvironmentPullRequestEntry["labels"] }) {
  if (labels.length === 0) return null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      {LABEL_SLOTS.map((slot, index) => {
        const label = labels[index];
        if (!label) return null;
        const remaining = labels.length - index - 1;
        return (
          <PullRequestLabelChip
            key={label.name}
            label={label}
            className={
              index === 0
                ? ""
                : index === 1
                  ? "hidden @xl/pr-row-meta:inline-flex"
                  : "hidden @3xl/pr-row-meta:inline-flex"
            }
          >
            {remaining > 0 ? (
              <span className={cn("shrink-0", slot.overflow)}>+{remaining}</span>
            ) : null}
          </PullRequestLabelChip>
        );
      })}
    </span>
  );
}

/**
 * The page row keeps a little more room around the shared lines than the panel, which sits in
 * a narrow column. The intrinsic size is the content box a skipped row reserves, which is the
 * two lines without the padding: a 56px row less 20px of `py-2.5`.
 */
const PAGE_ROW_CLASS = "px-3 py-2.5 [contain-intrinsic-block-size:36.5px]";

export type PullRequestRowTarget = Pick<
  EnvironmentPullRequestEntry,
  "environmentId" | "projectId" | "host" | "repository" | "number"
>;

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
  /** The owning project's favicon, shown as the row's avatar; a folder stands in without one. */
  projectIcon?: { workspaceRoot: string; faviconPath: string | null };
  /** Used by the list's shared visibility observer to defer optional line-count reads. */
  statsKey?: string;
  statsRef?: RefCallback<HTMLButtonElement>;
  onSelect: (entry: PullRequestRowTarget) => void;
}) {
  const state = resolvePullRequestState(entry);
  const conflicted = resolvePullRequestConflict(entry) !== null;
  const { Icon, providerName } = getSourceControlPresentationForKind(entry.provider);
  // The row is a stretched button under its content, so the checks, stack and number can be
  // real controls rather than spans nested inside a button. Content that is positioned paints
  // above the stretched button; the meta line drops its own pointer events so a click on it
  // still selects the row, and hands them back to the parts that carry a tooltip.
  return (
    <div
      className={cn(
        PULL_REQUEST_ROW_CLASS,
        PAGE_ROW_CLASS,
        "relative cursor-pointer gap-2.5 transition-colors",
        // Offscreen rows are skipped for style, layout and paint: a long list costs what the
        // viewport shows, not what the pages have loaded. The intrinsic size keeps the
        // scrollbar honest while a row is skipped.
        "[content-visibility:auto]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <button
        ref={statsRef}
        data-pull-request-stats-key={statsKey}
        type="button"
        aria-current={selected ? "true" : undefined}
        aria-label={`${entry.title}, ${entry.repository} #${entry.number}, ${state.label}`}
        onClick={() => onSelect(entry)}
        className="absolute inset-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {/* The project's own mark, with the lifecycle glyph on its corner — or the conflict
          warning, which only an open pull request can wear and which matters more. */}
      <span className="pointer-events-none relative flex size-[30px] shrink-0 items-center justify-center rounded-full border border-border bg-background">
        {projectIcon?.faviconPath ? (
          <ProjectFavicon
            project={{
              environmentId: entry.environmentId,
              workspaceRoot: projectIcon.workspaceRoot,
              title: entry.repository,
              faviconPath: projectIcon.faviconPath,
              projectIcon: null,
            }}
            className="size-[18px]"
            fallbackIcon={FolderGit2Icon}
          />
        ) : (
          <FolderGit2Icon aria-hidden className="size-[18px] text-muted-foreground" />
        )}
        <span className="absolute -right-1 -bottom-1 inline-flex rounded-full bg-background p-0.5">
          {conflicted ? (
            <PullRequestConflictGlyph
              state={entry.state}
              isDraft={entry.isDraft}
              {...(entry.mergeability === undefined ? {} : { mergeability: entry.mergeability })}
              {...(entry.baseBranch === undefined ? {} : { baseBranch: entry.baseBranch })}
              className="size-3"
            />
          ) : (
            <PullRequestStateGlyph state={entry.state} isDraft={entry.isDraft} className="size-3" />
          )}
        </span>
      </span>
      <PullRequestRowLines
        number={
          // The number carries the link, here as much as on the detail: a right-click on it
          // copies the pull request's own address rather than opening the editing menu.
          <button
            type="button"
            onClick={() => onSelect(entry)}
            className={cn(
              PULL_REQUEST_ROW_NUMBER_CLASS,
              "relative rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
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
        }
        title={entry.title}
        signals={
          <>
            {entry.checksState === undefined ? null : (
              <PullRequestChecksPopover
                checksState={entry.checksState}
                environmentId={entry.environmentId}
                reference={{
                  projectId: entry.projectId,
                  repository: entry.repository,
                  number: entry.number,
                }}
                className="relative"
              />
            )}
            {/* Only a verdict the host actually reports: an approval, a request for changes,
                or a review the branch rules still require. No glyph on the common case of a
                pull request nobody has reviewed, so a row only wears a person when the person
                has said something. */}
            {entry.reviewDecision === undefined ? null : (
              <span className="relative inline-flex">
                <PullRequestReviewDecisionGlyph decision={entry.reviewDecision} />
              </span>
            )}
          </>
        }
        status={
          <>
            {entry.stack ? (
              <span className="relative inline-flex">
                <PullRequestStackPopover
                  environmentId={entry.environmentId}
                  reference={{
                    projectId: entry.projectId,
                    host: entry.host,
                    repository: entry.repository,
                    number: entry.number,
                  }}
                  membership={entry.stack}
                  onSelect={(target) =>
                    onSelect({ ...target, host: entry.host, environmentId: entry.environmentId })
                  }
                />
              </span>
            ) : null}
            <PullRequestDiffStat
              additions={entry.additions}
              deletions={entry.deletions}
              className="font-mono"
            />
          </>
        }
        metaClassName="@container/pr-row-meta pointer-events-none"
        meta={
          <>
            {matchedElsewhere ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="pointer-events-auto flex min-w-6 items-center gap-1 overflow-hidden rounded-full border border-border/60 px-1 text-3xs" />
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
            {showProvider ? (
              <Tooltip>
                <TooltipTrigger
                  render={<span className="pointer-events-auto inline-flex shrink-0" />}
                >
                  <Icon aria-label={providerName} className="size-3" />
                </TooltipTrigger>
                <TooltipPopup>{providerName}</TooltipPopup>
              </Tooltip>
            ) : null}
            <PullRequestRowAuthor
              actor={entry.author}
              className="pointer-events-auto min-w-3.5 max-w-40"
              labelClassName="sr-only @xs/pr-row-meta:not-sr-only @xs/pr-row-meta:truncate"
            />
            {showProjectTitle ? <span className="truncate">{entry.repository}</span> : null}
            {environmentLabel ? (
              <span className="flex min-w-0 max-w-36 items-center gap-1">
                <EnvironmentIcon environmentId={entry.environmentId} className="size-3 shrink-0" />
                <span className="truncate">{environmentLabel}</span>
              </span>
            ) : null}
            {entry.labels.length > 0 ? <PullRequestRowLabels labels={entry.labels} /> : null}
          </>
        }
        updatedAt={entry.updatedAt}
      />
    </div>
  );
}

/**
 * Memoized: the list re-renders on every keystroke of a search and every status poll, and a
 * row whose entry, selection and match state are unchanged has nothing new to say. Effective
 * because the route hands it a stable `onSelect`.
 */
export const PullRequestRow = memo(PullRequestRowImpl);
