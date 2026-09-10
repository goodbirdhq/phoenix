import type {
  EnvironmentId,
  PullRequestListCursors,
  PullRequestListEntry,
  PullRequestListInput,
  PullRequestListProjectError,
  PullRequestListResult,
} from "@t3tools/contracts";

export const MOBILE_PULL_REQUEST_PAGE_SIZE = 30;

export function pullRequestPageInput(cursors: PullRequestListCursors | null): PullRequestListInput {
  return {
    state: "open",
    limit: MOBILE_PULL_REQUEST_PAGE_SIZE,
    ...(cursors === null ? {} : { cursors }),
  };
}

export interface PullRequestPageState {
  readonly entries: ReadonlyArray<PullRequestListEntry>;
  readonly errors: ReadonlyArray<PullRequestListProjectError>;
  readonly nextCursors: PullRequestListResult["nextCursors"];
  readonly truncated: boolean;
}

export const EMPTY_PULL_REQUEST_PAGE_STATE: PullRequestPageState = {
  entries: [],
  errors: [],
  nextCursors: {},
  truncated: false,
};

const entryKey = (entry: PullRequestListEntry) =>
  `${entry.host}\u0000${entry.repository}\u0000${entry.number}`;

function appendByKey<A>(
  previous: ReadonlyArray<A>,
  arrived: ReadonlyArray<A>,
  key: (value: A) => string,
): ReadonlyArray<A> {
  const arrivedByKey = new Map(arrived.map((value) => [key(value), value]));
  const seen = new Set<string>();
  const merged = previous.map((value) => {
    const valueKey = key(value);
    seen.add(valueKey);
    return arrivedByKey.get(valueKey) ?? value;
  });
  for (const [valueKey, value] of arrivedByKey) {
    if (!seen.has(valueKey)) {
      seen.add(valueKey);
      merged.push(value);
    }
  }
  return merged;
}

function sortByUpdatedAt(
  entries: ReadonlyArray<PullRequestListEntry>,
): ReadonlyArray<PullRequestListEntry> {
  return [...entries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** A cursor response is only the next slice, so retain earlier slices and replace overlaps. */
export function applyPullRequestPage(
  previous: PullRequestPageState,
  page: PullRequestListResult,
  mode: "replace" | "append",
): PullRequestPageState {
  const entries =
    mode === "replace" ? page.entries : appendByKey(previous.entries, page.entries, entryKey);
  return {
    // A continuation is sorted only within its own response. Re-sort the
    // accumulated rows because one repository's next slice can still be
    // newer than another repository's first slice.
    entries: sortByUpdatedAt(entries),
    errors:
      mode === "replace"
        ? page.errors
        : appendByKey(previous.errors, page.errors, (error) => String(error.projectId)),
    nextCursors: page.nextCursors,
    truncated: page.truncated,
  };
}

export function hasPullRequestContinuation(state: PullRequestPageState): boolean {
  return Object.keys(state.nextCursors).length > 0;
}

/** Drop saved continuation requests as soon as their environment stops being queryable. */
export function retainQueryablePullRequestPages<A>(
  pages: ReadonlyMap<EnvironmentId, A>,
  queryableEnvironmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyMap<EnvironmentId, A> {
  const queryable = new Set(queryableEnvironmentIds);
  if ([...pages.keys()].every((environmentId) => queryable.has(environmentId))) return pages;
  return new Map([...pages].filter(([environmentId]) => queryable.has(environmentId)));
}

export interface PullRequestQueryObservation<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

/**
 * A forced refresh first exposes the query atom's cached snapshot. Hold that
 * snapshot back until an atom subscription observes the refresh finish, and
 * never replace displayed rows with cached data on failure.
 */
export function observeForcedPullRequestRefresh<A>(
  refreshCompleted: boolean,
  observation: PullRequestQueryObservation<A>,
): PullRequestQueryObservation<A> | null {
  if (!refreshCompleted) return null;
  return observation.error === null ? observation : { ...observation, data: null };
}
