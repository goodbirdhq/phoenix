import type {
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
  for (const value of arrived) {
    if (!seen.has(key(value))) merged.push(value);
  }
  return merged;
}

/** A cursor response is only the next slice, so retain earlier slices and replace overlaps. */
export function applyPullRequestPage(
  previous: PullRequestPageState,
  page: PullRequestListResult,
  mode: "replace" | "append",
): PullRequestPageState {
  return {
    entries:
      mode === "replace" ? page.entries : appendByKey(previous.entries, page.entries, entryKey),
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
