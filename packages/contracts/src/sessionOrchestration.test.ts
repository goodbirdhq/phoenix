import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ReadSessionResult,
  SpawnSessionInput,
  SpawnSessionResult,
} from "./sessionOrchestration.ts";

describe("SpawnSessionInput", () => {
  it("decodes the git checkout specification", () => {
    expect(
      Schema.decodeUnknownSync(SpawnSessionInput)({
        prompt: "Review this revision",
        gitRef: "feature/review",
        baseRef: "main",
        branchName: "review/feature",
      }),
    ).toMatchObject({
      gitRef: "feature/review",
      baseRef: "main",
      branchName: "review/feature",
    });
    expect(
      Schema.decodeUnknownSync(SpawnSessionInput)({ prompt: "Review PR", checkoutPr: 42 }),
    ).toMatchObject({ checkoutPr: 42 });
  });

  it("requires checkoutPr to be a positive integer", () => {
    for (const checkoutPr of [0, -1, 1.5, "42"]) {
      expect(() =>
        Schema.decodeUnknownSync(SpawnSessionInput)({ prompt: "Review PR", checkoutPr }),
      ).toThrow();
    }
  });
});

describe("session checkout result contracts", () => {
  it("decodes resolved checkout fields from spawn and read results", () => {
    const base = {
      threadId: "thread-1",
      title: "Review",
      projectId: "project-1",
      modelSelection: { instanceId: "provider", model: "model" },
      runtimeMode: "auto",
      branch: "review/feature",
      worktreePath: "/tmp/review",
      sha: "0123456789abcdef",
      dirty: false,
    };
    expect(Schema.decodeUnknownSync(SpawnSessionResult)(base)).toMatchObject(base);
    expect(
      Schema.decodeUnknownSync(ReadSessionResult)({
        threadId: base.threadId,
        title: base.title,
        sessionStatus: null,
        settled: false,
        report: null,
        messages: [],
        branch: base.branch,
        worktreePath: base.worktreePath,
        sha: base.sha,
        dirty: base.dirty,
      }),
    ).toMatchObject({
      branch: base.branch,
      worktreePath: base.worktreePath,
      sha: base.sha,
      dirty: false,
    });
  });
});
