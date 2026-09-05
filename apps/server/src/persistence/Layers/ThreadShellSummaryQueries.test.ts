// @effect-diagnostics nodeBuiltinImport:off
/**
 * The narrow reads behind `refreshThreadShellSummary`.
 *
 * That refresh runs on nearly every thread event, so it must derive its four
 * values without paging in whole thread histories. These tests pin the two
 * queries that make that possible, and guard the one coupling the narrowing
 * introduces: the SQL kind filter has to keep matching the branches in
 * `derivePendingUserInputCountFromActivities`.
 */
import * as NodeFS from "node:fs";

import { EventId, MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import {
  PENDING_USER_INPUT_ACTIVITY_KINDS,
  type ProjectionThreadActivity,
  ProjectionThreadActivityRepository,
} from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";

const thread = (name: string) => ThreadId.make(`thread-shell-summary-${name}`);

const layer = it.layer(
  Layer.mergeAll(
    ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

const activity = (
  threadId: ThreadId,
  id: string,
  kind: string,
  createdAt: string,
  payload: unknown = {},
): ProjectionThreadActivity => ({
  activityId: EventId.make(id),
  threadId,
  turnId: null,
  tone: "info",
  kind,
  summary: kind,
  payload,
  createdAt,
});

const message = (
  threadId: ThreadId,
  id: string,
  role: "user" | "assistant",
  createdAt: string,
) => ({
  messageId: MessageId.make(id),
  threadId,
  turnId: null,
  role,
  text: "hi",
  isStreaming: false,
  createdAt,
  updatedAt: createdAt,
});

layer("Thread shell summary queries", (it) => {
  it.effect("listUserInputLifecycleByThreadId returns only the kinds the tally folds over", () =>
    Effect.gen(function* () {
      const activities = yield* ProjectionThreadActivityRepository;
      const threadId = thread("kinds");

      // Interleave the relevant kinds with high-volume noise, including noise
      // that carries a requestId — the fold ignores those, so the query must
      // not return them.
      yield* activities.upsert(
        activity(threadId, "a1", "user-input.requested", "2026-01-01T00:00:01.000Z", {
          requestId: "r1",
        }),
      );
      yield* activities.upsert(
        activity(threadId, "a2", "tool.completed", "2026-01-01T00:00:02.000Z", {
          requestId: "r-noise",
        }),
      );
      yield* activities.upsert(
        activity(threadId, "a3", "context-window.updated", "2026-01-01T00:00:03.000Z"),
      );
      yield* activities.upsert(
        activity(threadId, "a4", "user-input.resolved", "2026-01-01T00:00:04.000Z", {
          requestId: "r1",
        }),
      );
      yield* activities.upsert(
        activity(threadId, "a5", "provider.user-input.respond.failed", "2026-01-01T00:00:05.000Z", {
          requestId: "r2",
          detail: "stale pending user-input request",
        }),
      );

      const narrowed = yield* activities.listUserInputLifecycleByThreadId({ threadId });

      assert.deepStrictEqual(
        narrowed.map((row) => row.activityId),
        ["a1", "a4", "a5"],
      );
      for (const row of narrowed) {
        assert.include(PENDING_USER_INPUT_ACTIVITY_KINDS as ReadonlyArray<string>, row.kind);
      }
    }),
  );

  it.effect("listUserInputLifecycleByThreadId preserves the ordering of the full list", () =>
    Effect.gen(function* () {
      const activities = yield* ProjectionThreadActivityRepository;
      const threadId = thread("ordering");

      yield* activities.upsert(
        activity(threadId, "b3", "user-input.requested", "2026-01-01T00:00:03.000Z", {
          requestId: "r3",
        }),
      );
      yield* activities.upsert(
        activity(threadId, "b2", "tool.started", "2026-01-01T00:00:02.000Z"),
      );
      yield* activities.upsert(
        activity(threadId, "b1", "user-input.requested", "2026-01-01T00:00:01.000Z", {
          requestId: "r1",
        }),
      );

      const all = yield* activities.listByThreadId({ threadId });
      const narrowed = yield* activities.listUserInputLifecycleByThreadId({ threadId });

      const expected = all
        .filter((row) =>
          (PENDING_USER_INPUT_ACTIVITY_KINDS as ReadonlyArray<string>).includes(row.kind),
        )
        .map((row) => row.activityId);
      assert.deepStrictEqual(
        narrowed.map((row) => row.activityId),
        expected,
      );
    }),
  );

  it.effect("listUserInputLifecycleByThreadId stays scoped to its thread", () =>
    Effect.gen(function* () {
      const activities = yield* ProjectionThreadActivityRepository;
      const threadId = thread("scope");
      const otherThreadId = thread("scope-other");

      yield* activities.upsert(
        activity(threadId, "c1", "user-input.requested", "2026-01-01T00:00:01.000Z", {
          requestId: "r1",
        }),
      );
      yield* activities.upsert(
        activity(otherThreadId, "c2", "user-input.requested", "2026-01-01T00:00:02.000Z", {
          requestId: "r2",
        }),
      );

      const narrowed = yield* activities.listUserInputLifecycleByThreadId({ threadId });
      assert.deepStrictEqual(
        narrowed.map((row) => row.activityId),
        ["c1"],
      );
    }),
  );

  it.effect("getLatestUserMessageAt takes the newest user message, ignoring assistants", () =>
    Effect.gen(function* () {
      const messages = yield* ProjectionThreadMessageRepository;
      const threadId = thread("latest");

      yield* messages.upsert(message(threadId, "m1", "user", "2026-01-01T00:00:01.000Z"));
      yield* messages.upsert(message(threadId, "m2", "assistant", "2026-01-01T00:00:09.000Z"));
      yield* messages.upsert(message(threadId, "m3", "user", "2026-01-01T00:00:05.000Z"));
      yield* messages.upsert(message(threadId, "m4", "user", "2026-01-01T00:00:02.000Z"));

      const latest = yield* messages.getLatestUserMessageAt({ threadId });
      assert.strictEqual(latest, "2026-01-01T00:00:05.000Z");
    }),
  );

  it.effect("getLatestUserMessageAt is null when the thread has no user messages", () =>
    Effect.gen(function* () {
      const messages = yield* ProjectionThreadMessageRepository;
      const threadId = thread("no-user-messages");
      const emptyThreadId = thread("never-written");

      yield* messages.upsert(message(threadId, "n1", "assistant", "2026-01-01T00:00:01.000Z"));

      assert.strictEqual(yield* messages.getLatestUserMessageAt({ threadId }), null);
      assert.strictEqual(yield* messages.getLatestUserMessageAt({ threadId: emptyThreadId }), null);
    }),
  );
});

it("the kind filter covers every branch the pending-user-input fold takes", () => {
  // The query narrows by kind, so a branch added to the fold without its kind
  // added to PENDING_USER_INPUT_ACTIVITY_KINDS would silently stop counting.
  // Read the fold's own source rather than trusting the two to drift together.
  const source = NodeFS.readFileSync(
    new URL("../../orchestration/Layers/ProjectionPipeline.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function derivePendingUserInputCountFromActivities(");
  assert.isAbove(start, -1, "fold not found — did it get renamed?");
  const end = source.indexOf("\nfunction ", start + 1);
  assert.isAbove(end, start, "could not find the end of the fold");

  const branchKinds = new Set(
    [...source.slice(start, end).matchAll(/activity\.kind === "([^"]+)"/g)].map(
      (match) => match[1],
    ),
  );

  assert.deepStrictEqual(
    [...branchKinds].toSorted(),
    [...PENDING_USER_INPUT_ACTIVITY_KINDS].toSorted(),
  );
});
