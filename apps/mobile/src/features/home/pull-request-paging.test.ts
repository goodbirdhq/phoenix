import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  type PullRequestListEntry,
  type PullRequestListResult,
} from "@t3tools/contracts";
import {
  applyPullRequestPage,
  EMPTY_PULL_REQUEST_PAGE_STATE,
  hasPullRequestContinuation,
  observeForcedPullRequestRefresh,
  pullRequestPageInput,
  retainQueryablePullRequestPages,
} from "./pull-request-paging";

const entry = (
  number: number,
  title = `PR ${number}`,
  updatedAt = `2026-09-${String(number).padStart(2, "0")}T00:00:00.000Z`,
): PullRequestListEntry =>
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
    updatedAt,
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

  it("re-sorts accumulated repositories and removes overlap within an arrived slice", () => {
    const first = applyPullRequestPage(
      EMPTY_PULL_REQUEST_PAGE_STATE,
      page([
        entry(4, "Newest in repo A", "2026-09-04T00:00:00.000Z"),
        entry(1, "Old row in repo B", "2026-09-01T00:00:00.000Z"),
      ]),
      "replace",
    );
    const second = applyPullRequestPage(
      first,
      page([
        entry(3, "Next in repo A", "2026-09-03T00:00:00.000Z"),
        entry(3, "Duplicate boundary row", "2026-09-03T00:00:00.000Z"),
      ]),
      "append",
    );

    expect(second.entries.map(({ number }) => number)).toEqual([4, 3, 1]);
    expect(second.entries[1]?.title).toBe("Duplicate boundary row");
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

  it("drops a saved continuation when its environment becomes unqueryable", () => {
    const online = EnvironmentId.make("online");
    const disconnected = EnvironmentId.make("disconnected");
    const pages = new Map([
      [online, "first-page"],
      [disconnected, "saved-continuation"],
    ]);

    const retained = retainQueryablePullRequestPages(pages, [online]);

    expect([...retained]).toEqual([[online, "first-page"]]);
    expect(retainQueryablePullRequestPages(retained, [online])).toBe(retained);
  });
});

describe("forced mobile pull request refresh", () => {
  it("ignores cached and pending snapshots until the refresh generation completes", () => {
    const cached = { data: page([entry(2)]), error: null, isPending: false };

    expect(observeForcedPullRequestRefresh(false, cached)).toBeNull();
    expect(
      observeForcedPullRequestRefresh(false, {
        data: cached.data,
        error: null,
        isPending: true,
      }),
    ).toBeNull();
  });

  it("reports fresh success but preserves retained rows when refresh fails", () => {
    const fresh = page([entry(3)]);

    expect(
      observeForcedPullRequestRefresh(true, {
        data: fresh,
        error: null,
        isPending: false,
      }),
    ).toEqual({ data: fresh, error: null, isPending: false });
    expect(
      observeForcedPullRequestRefresh(true, {
        data: page([entry(2)]),
        error: "Offline",
        isPending: false,
      }),
    ).toEqual({ data: null, error: "Offline", isPending: false });
  });
});
