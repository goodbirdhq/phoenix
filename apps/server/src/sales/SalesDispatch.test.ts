import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  OrchestrationDispatchCommandError,
  ProjectId,
  SalesActionError,
  type SalesContactRef,
  type SalesConversationDetail,
  type SalesDispatchAction,
  type SalesDispatchPlans,
  type SalesQueueItemDetail,
  type ServerProvider,
  salesDispatchThreadPrefix,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadTurnBootstrap from "../orchestration/ThreadTurnBootstrap.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SalesDispatch from "./SalesDispatch.ts";
import * as SalesService from "./SalesService.ts";

const isSalesActionError = Schema.is(SalesActionError);

const contact: SalesContactRef = {
  id: "contact-1",
  name: "Ana",
  email: "ana@brand.example",
  accountName: "Brand",
  timeZone: null,
  effectiveTimeZone: "America/Los_Angeles",
  notionUrl: "https://www.notion.so/contact1",
  linkedinUrl: null,
};

const HASH = "a".repeat(64);
const action = (overrides: Partial<SalesDispatchAction> = {}): SalesDispatchAction => ({
  title: "Redraft for Ana",
  skill: "some-workflow",
  prompt: "Run it.\nTarget: x{{note}}\n\nReport back.",
  noteRequired: true,
  discardFirst: false,
  card: { activityId: "act-1", expectedHash: HASH },
  ...overrides,
});
const plans = (overrides: Partial<SalesDispatchPlans> = {}): SalesDispatchPlans => ({
  redraft: null,
  research: null,
  answer: null,
  ...overrides,
});
const reasonOf = (checked: ReturnType<typeof SalesDispatch.checkPlan>) =>
  "_tag" in checked ? checked.reason : "ok";

it("fills the engine's prompt with the note block", () => {
  const checked = SalesDispatch.checkPlan(
    { activityId: "act-1", action: "redraft", expectedHash: HASH.toUpperCase(), note: "Shorter." },
    plans({ redraft: action() }),
  );
  assert.strictEqual(
    "_tag" in checked ? null : checked.prompt,
    "Run it.\nTarget: x\nNote from Gabriel:\nShorter.\n\nReport back.",
  );
});

it("starts nothing the fresh plan no longer offers", () => {
  const checked = SalesDispatch.checkPlan(
    { activityId: "act-1", action: "redraft", expectedHash: HASH, note: "Shorter." },
    plans({ research: action({ card: null }) }),
  );
  assert.strictEqual(reasonOf(checked), "no-target");
});

it("refuses a plan whose card moved on from the version the person saw", () => {
  const stale = SalesDispatch.checkPlan(
    { activityId: "act-1", action: "redraft", expectedHash: "b".repeat(64), note: "Shorter." },
    plans({ redraft: action() }),
  );
  assert.strictEqual(reasonOf(stale), "stale_hash");
  assert.strictEqual("_tag" in stale ? stale.currentHash : null, HASH);
  // Phoenix refused before asking the engine, so the client reads it as nothing sent.
  assert.strictEqual("_tag" in stale ? stale.origin : null, "phoenix");
  // A card plan the person saw no version of is stale too.
  const unseen = SalesDispatch.checkPlan(
    { activityId: "act-1", action: "redraft", expectedHash: null, note: "Shorter." },
    plans({ redraft: action() }),
  );
  assert.strictEqual(reasonOf(unseen), "stale_hash");
});

it("enforces noteRequired on the note as it would enter the prompt", () => {
  const input = { activityId: "act-1", action: "redraft", expectedHash: HASH } as const;
  assert.strictEqual(
    reasonOf(SalesDispatch.checkPlan({ ...input, note: " \r\n\t " }, plans({ redraft: action() }))),
    "bad_request",
  );
  const optional = SalesDispatch.checkPlan(
    { contactKey: "c1", action: "answer", expectedHash: null, note: "" },
    plans({ answer: action({ noteRequired: false, card: null }) }),
  );
  assert.strictEqual(
    "_tag" in optional ? null : optional.prompt,
    "Run it.\nTarget: x\n\nReport back.",
  );
});

it("refuses a prompt that does not hold the note token exactly once", () => {
  for (const prompt of ["No token.", "{{note}} twice {{note}}"]) {
    const checked = SalesDispatch.checkPlan(
      { activityId: "act-1", action: "research", expectedHash: null, note: "" },
      plans({ research: action({ prompt, card: null, noteRequired: false }) }),
    );
    assert.strictEqual(reasonOf(checked), "dispatch-failed");
  }
});

// --- The service: where the thread starts, and the reply redraft's order ----------------------

const replyPlan = action({
  title: "Redraft for Ana",
  discardFirst: true,
  card: { activityId: "act-reply", expectedHash: HASH },
});

const replyCard: SalesQueueItemDetail = {
  activityId: "act-reply",
  kind: "reply",
  step: 2,
  stepLabel: "Email 2",
  contact,
  campaign: null,
  subject: "Re: hello",
  threaded: true,
  bodyPreview: "Thanks",
  contentHash: HASH,
  state: "awaiting",
  approval: null,
  sendAt: null,
  goes: null,
  mailbox: { sticky: true, address: "gabe@trygoodbird.com", threadState: "replied" },
  refusal: null,
  note: null,
  check: null,
  skip: null,
  sendStatus: null,
  notionUrl: "https://www.notion.so/act",
  rowEditedAt: null,
  body: "Thanks, Ana.",
  rowName: "Draft reply to Ana - Brand",
  hashInput: {
    toAddress: "ana@brand.example",
    subject: "Re: hello",
    body: "Thanks, Ana.",
    rowName: "Draft reply to Ana - Brand",
    step: 2,
    gmailThreadId: "t1",
    answers: "m1",
  },
  hashAlgorithm: "sha256 hex of JSON.stringify([...])",
  dispatch: plans({ redraft: replyPlan }),
};

const conversation: SalesConversationDetail = {
  generatedAt: "2026-11-10T09:00:00.000Z",
  contactKey: "contact-1",
  contact,
  thread: null,
  messages: [],
  drafts: [],
  dispatch: plans({
    answer: action({ title: "Draft an answer to Ana", noteRequired: false, card: null }),
  }),
};

const provider = {
  instanceId: "codex",
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  availability: "available",
  models: [{ slug: "gpt-5", isDefault: true }],
} as unknown as ServerProvider;

function makeDispatchLayer(input: {
  readonly agentsProjectId: string;
  readonly bootstrapFails?: boolean;
}) {
  const calls: Array<string> = [];
  const commands: Array<ThreadTurnBootstrap.ThreadTurnStartCommand> = [];
  const sales = Layer.mock(SalesService.SalesService)({
    getQueueItem: () => Effect.succeed(replyCard),
    getConversation: () => Effect.succeed(conversation),
    discard: (args) => {
      calls.push(`discard:${args.expectedHash}`);
      return Effect.succeed({
        activityId: args.activityId,
        contentHash: args.expectedHash,
        state: "discarded",
        approved: false,
        approvedBy: null,
        sendAt: null,
        goes: null,
        refusal: null,
        note: null,
      });
    },
  });
  const projection = Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
    getProjectShellById: (projectId) =>
      Effect.succeed(
        projectId === "project-birdhouse"
          ? Option.some({
              id: ProjectId.make("project-birdhouse"),
              title: "birdhouse",
              workspaceRoot: "/code/birdhouse",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            })
          : Option.none(),
      ),
  });
  const bootstrap = Layer.mock(ThreadTurnBootstrap.ThreadTurnBootstrap)({
    bootstrapTurnStart: (command) => {
      calls.push("bootstrap");
      commands.push(command);
      return input.bootstrapFails
        ? Effect.fail(new OrchestrationDispatchCommandError({ message: "No worktree." }))
        : Effect.succeed({ sequence: 1 });
    },
  });
  const layer = SalesDispatch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        sales,
        projection,
        bootstrap,
        Layer.mock(T3ProjectFileLoader.T3ProjectFileLoader)({
          load: () => Effect.succeed(Option.none()),
        }),
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed({ isRepo: true, refName: "main" } as never),
        }),
        ServerSettings.layerTest({
          defaultThreadEnvMode: "worktree",
          salesEngine: { agentsProjectId: input.agentsProjectId },
        }),
        NodeCrypto.layer,
      ),
    ),
  );
  return { layer, calls, commands };
}

const redraftReply = {
  activityId: "act-reply",
  action: "redraft",
  expectedHash: HASH,
  note: "Offer Thursday.",
} as const;

it.effect("discards the plan's card for the version shown, then starts its thread", () => {
  const { layer, calls, commands } = makeDispatchLayer({ agentsProjectId: "project-birdhouse" });
  return Effect.gen(function* () {
    const dispatch = yield* SalesDispatch.SalesDispatchService;
    const result = yield* dispatch.dispatch(redraftReply);
    assert.deepStrictEqual(calls, [`discard:${HASH}`, "bootstrap"]);
    assert.strictEqual(result.title, "Redraft for Ana");
    const command = commands[0];
    assert.strictEqual(command?.threadId, result.threadId);
    assert.isTrue(result.threadId.startsWith(salesDispatchThreadPrefix(redraftReply)));
    assert.strictEqual(
      command?.message.text,
      "Run it.\nTarget: x\nNote from Gabriel:\nOffer Thursday.\n\nReport back.",
    );
    assert.strictEqual(command?.bootstrap?.createThread?.title, "Redraft for Ana");
    // The project's default thread mode: a fresh worktree off its current branch.
    assert.strictEqual(command?.bootstrap?.prepareWorktree?.baseBranch, "main");
    assert.strictEqual(command?.bootstrap?.createThread?.projectId, "project-birdhouse");
  }).pipe(Effect.provide(layer));
});

it.effect("starts a conversation's plan under the contact, discarding nothing", () => {
  const { layer, calls, commands } = makeDispatchLayer({ agentsProjectId: "project-birdhouse" });
  return Effect.gen(function* () {
    const dispatch = yield* SalesDispatch.SalesDispatchService;
    const input = {
      contactKey: "contact-1",
      action: "answer",
      expectedHash: null,
      note: "",
    } as const;
    const result = yield* dispatch.dispatch(input);
    assert.deepStrictEqual(calls, ["bootstrap"]);
    assert.isTrue(result.threadId.startsWith("sales:contact:contact-1:"));
    assert.strictEqual(commands[0]?.message.text, "Run it.\nTarget: x\n\nReport back.");
  }).pipe(Effect.provide(layer));
});

it.effect("discards nothing for a card that moved on", () => {
  const { layer, calls } = makeDispatchLayer({ agentsProjectId: "project-birdhouse" });
  return Effect.gen(function* () {
    const dispatch = yield* SalesDispatch.SalesDispatchService;
    const exit = yield* dispatch
      .dispatch({ ...redraftReply, expectedHash: "b".repeat(64) })
      .pipe(Effect.exit);
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;
    assert.strictEqual(isSalesActionError(error) ? error.reason : null, "stale_hash");
    assert.deepStrictEqual(calls, []);
  }).pipe(Effect.provide(layer));
});

it.effect("discards nothing when there is no agents project to run the redraft", () => {
  const { layer, calls } = makeDispatchLayer({ agentsProjectId: "" });
  return Effect.gen(function* () {
    const dispatch = yield* SalesDispatch.SalesDispatchService;
    const exit = yield* dispatch.dispatch(redraftReply).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(exit));
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;
    assert.isTrue(isSalesActionError(error));
    assert.strictEqual(isSalesActionError(error) ? error.reason : null, "no-agents-project");
    assert.deepStrictEqual(calls, []);
  }).pipe(Effect.provide(layer));
});

it.effect("says the card was discarded when the run that replaces it fails to start", () => {
  const { layer, calls } = makeDispatchLayer({
    agentsProjectId: "project-birdhouse",
    bootstrapFails: true,
  });
  return Effect.gen(function* () {
    const dispatch = yield* SalesDispatch.SalesDispatchService;
    const exit = yield* dispatch.dispatch(redraftReply).pipe(Effect.exit);
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;
    assert.isTrue(isSalesActionError(error));
    if (isSalesActionError(error)) {
      assert.strictEqual(error.reason, "dispatch-failed");
      assert.strictEqual(error.state, "discarded");
    }
    assert.deepStrictEqual(calls, [`discard:${HASH}`, "bootstrap"]);
  }).pipe(Effect.provide(layer));
});
