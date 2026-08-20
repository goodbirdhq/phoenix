import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe } from "vite-plus/test";
import { type OrchestrationThread, ThreadId } from "@t3tools/contracts";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  buildConversationSeed,
  formatConversationSeedPrompt,
  readThreadConversationSeed,
  seedForFreshSession,
} from "./conversationSeed.ts";

const THREAD_ID = ThreadId.make("thread-seed-1");
const NOW = "2026-08-19T00:00:00.000Z";

function makeSnapshotQueryLayer(
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }> | undefined,
) {
  return Effect.provideService(
    ProjectionSnapshotQuery,
    ProjectionSnapshotQuery.of({
      getThreadDetailById: (threadId: ThreadId) =>
        threadId === THREAD_ID && messages !== undefined
          ? Effect.succeed(
              Option.some({
                id: threadId,
                messages: messages.map((message, index) => ({
                  id: `message-${index}`,
                  role: message.role,
                  text: message.text,
                  attachments: [],
                  turnId: null,
                  streaming: false,
                  createdAt: NOW,
                  updatedAt: NOW,
                })),
              } as unknown as OrchestrationThread),
            )
          : Effect.succeed(Option.none()),
    } as unknown as ProjectionSnapshotQuery["Service"]),
  );
}

describe("buildConversationSeed", () => {
  it("keeps user and assistant turns in order and drops the rest", () => {
    const build = buildConversationSeed({
      messages: [
        { role: "user", text: "  add a test  " },
        { role: "system", text: "session started" },
        { role: "assistant", text: "done" },
        { role: "user", text: "   " },
      ],
    });

    NodeAssert.deepStrictEqual(build.seed.messages, [
      { role: "user", text: "add a test" },
      { role: "assistant", text: "done" },
    ]);
    NodeAssert.equal(build.droppedMessageCount, 0);
    NodeAssert.equal(build.seed.droppedMessageCount, undefined);
  });

  it("drops the oldest messages first when the transcript is over budget", () => {
    const build = buildConversationSeed({
      messages: [
        { role: "user", text: "one" },
        { role: "assistant", text: "two" },
        { role: "user", text: "three" },
        { role: "assistant", text: "four" },
      ],
      limits: { maxMessages: 2, maxTotalCharacters: 10_000, maxMessageCharacters: 10_000 },
    });

    NodeAssert.deepStrictEqual(build.seed.messages, [
      { role: "user", text: "three" },
      { role: "assistant", text: "four" },
    ]);
    NodeAssert.equal(build.droppedMessageCount, 2);
    NodeAssert.equal(build.seed.droppedMessageCount, 2);
  });

  it("marks a message that had to be shortened", () => {
    const build = buildConversationSeed({
      messages: [{ role: "assistant", text: "x".repeat(500) }],
      limits: { maxMessages: 10, maxTotalCharacters: 10_000, maxMessageCharacters: 100 },
    });

    NodeAssert.equal(build.truncatedMessageCount, 1);
    NodeAssert.ok(build.seed.messages[0]?.text.startsWith("x".repeat(100)));
    NodeAssert.ok(build.seed.messages[0]?.text.includes("message truncated by Phoenix"));
  });

  it("keeps a brief even when there is no transcript", () => {
    const build = buildConversationSeed({
      messages: [],
      brief: "  The user wants the flaky test fixed.  ",
    });

    NodeAssert.deepStrictEqual(build.seed.messages, []);
    NodeAssert.equal(build.seed.brief, "The user wants the flaky test fixed.");
  });
});

describe("formatConversationSeedPrompt", () => {
  it("frames the transcript so the agent continues instead of replying to it", () => {
    const framed = formatConversationSeedPrompt({
      messages: [
        { role: "user", text: "add a test" },
        { role: "assistant", text: "added it" },
      ],
    });

    NodeAssert.ok(framed);
    NodeAssert.ok(framed.startsWith("<phoenix-prior-conversation>"));
    NodeAssert.ok(framed.endsWith("</phoenix-prior-conversation>"));
    NodeAssert.ok(framed.includes("Continue the work from it"));
    NodeAssert.ok(framed.includes("### user\n\nadd a test"));
    NodeAssert.ok(framed.includes("### assistant\n\nadded it"));
  });

  it("says out loud how much history was dropped and carries the brief", () => {
    const framed = formatConversationSeedPrompt({
      messages: [{ role: "user", text: "carry on" }],
      brief: "We refactored the reactor.",
      droppedMessageCount: 12,
    });

    NodeAssert.ok(framed);
    NodeAssert.ok(framed.includes("the 12 oldest message(s) were dropped"));
    NodeAssert.ok(framed.includes("We refactored the reactor."));
  });

  it("has nothing to say about an empty seed", () => {
    NodeAssert.equal(formatConversationSeedPrompt({ messages: [] }), undefined);
  });
});

describe("readThreadConversationSeed", () => {
  it.effect("rebuilds the seed from the thread's projected messages", () =>
    Effect.gen(function* () {
      const seed = yield* readThreadConversationSeed({ threadId: THREAD_ID });

      NodeAssert.ok(Option.isSome(seed));
      NodeAssert.deepStrictEqual(seed.value.messages, [
        { role: "user", text: "add a test" },
        { role: "assistant", text: "added it" },
      ]);
    }).pipe(
      makeSnapshotQueryLayer([
        { role: "user", text: "add a test" },
        { role: "system", text: "checkpoint created" },
        { role: "assistant", text: "added it" },
      ]),
    ),
  );

  it.effect("returns nothing for a thread with no usable history", () =>
    Effect.gen(function* () {
      const seed = yield* readThreadConversationSeed({ threadId: THREAD_ID });

      NodeAssert.ok(Option.isNone(seed));
    }).pipe(makeSnapshotQueryLayer([{ role: "system", text: "session started" }])),
  );

  it.effect("returns nothing for a thread that is not in the read model", () =>
    Effect.gen(function* () {
      const seed = yield* readThreadConversationSeed({ threadId: THREAD_ID });

      NodeAssert.ok(Option.isNone(seed));
    }).pipe(makeSnapshotQueryLayer(undefined)),
  );
});

describe("seedForFreshSession", () => {
  it.effect("passes the seed through for a fresh session", () =>
    Effect.gen(function* () {
      const seed = yield* seedForFreshSession({
        threadId: THREAD_ID,
        seed: { messages: [{ role: "user", text: "carry on" }] },
        resuming: false,
      });

      NodeAssert.deepStrictEqual(seed?.messages, [{ role: "user", text: "carry on" }]);
    }),
  );

  it.effect("skips seeding a session that resumes native provider history", () =>
    Effect.gen(function* () {
      const seed = yield* seedForFreshSession({
        threadId: THREAD_ID,
        seed: { messages: [{ role: "user", text: "carry on" }] },
        resuming: true,
      });

      NodeAssert.equal(seed, undefined);
    }),
  );
});
