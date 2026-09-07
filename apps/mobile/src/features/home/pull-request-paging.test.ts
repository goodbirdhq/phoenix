import { describe, expect, it } from "vite-plus/test";
import type { PullRequestListEntry, PullRequestListResult } from "@t3tools/contracts";
import {
  applyPullRequestPage,
  EMPTY_PULL_REQUEST_PAGE_STATE,
  hasPullRequestContinuation,
  pullRequestPageInput,
} from "./pull-request-paging";

const entry = (number: number, title = `PR ${number}`): PullRequestListEntry =>
  ({
    provider: "github",
    host: "github.com",
    projectId: "project-1",
    projectTitle: "Phoenix",
    repository: "goodbirdhq/phoenix",
    number,
    title,
    url: `https://github.com/goodbirdhq/phoenix/pull/${number}`,
    author: null,
    headBranch: `branch-${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "unknown",
    additions: 0,
    deletions: 0,
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    viewerReviewRequested: false,
    labels: [],
  }) as unknown as PullRequestListEntry;

const page = (
  entries: ReadonlyArray<PullRequestListEntry>,
  nextCursors: PullRequestListResult["nextCursors"] = {},
): PullRequestListResult =>
  ({
    viewers: {},
    providers: [],
    entries,
    errors: [],
    truncated: Object.keys(nextCursors).length > 0,
    nextCursors,
  }) as PullRequestListResult;

describe("mobile pull request paging", () => {
  it("requests a bounded continuation from repository cursors", () => {
    const cursors = { "github.com goodbirdhq/phoenix": "cursor-1" };

    expect(pullRequestPageInput(cursors)).toEqual({ state: "open", limit: 30, cursors });
    expect(pullRequestPageInput(null)).toEqual({ state: "open", limit: 30 });
  });

  it("appends a cursor slice without discarding or duplicating earlier rows", () => {
    const first = applyPullRequestPage(
      EMPTY_PULL_REQUEST_PAGE_STATE,
      page([entry(3), entry(2)], { "github.com goodbirdhq/phoenix": "cursor-1" }),
      "replace",
    );
    const second = applyPullRequestPage(
      first,
      page([entry(2, "PR 2 updated"), entry(1)]),
      "append",
    );

    expect(second.entries.map(({ number }) => number)).toEqual([3, 2, 1]);
    expect(second.entries[1]?.title).toBe("PR 2 updated");
    expect(hasPullRequestContinuation(second)).toBe(false);
  });

  it("replaces accumulated slices on a bounded refresh", () => {
    const accumulated = applyPullRequestPage(
      EMPTY_PULL_REQUEST_PAGE_STATE,
      page([entry(3), entry(2), entry(1)]),
      "append",
    );
    const refreshed = applyPullRequestPage(
      accumulated,
      page([entry(4)], { "github.com goodbirdhq/phoenix": "cursor-2" }),
      "replace",
    );

    expect(refreshed.entries.map(({ number }) => number)).toEqual([4]);
    expect(hasPullRequestContinuation(refreshed)).toBe(true);
  });
});
