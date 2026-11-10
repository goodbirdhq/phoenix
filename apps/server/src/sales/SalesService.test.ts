import { assert, it } from "@effect/vitest";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { ProjectId, SalesActionError, type SalesStreamEvent, ThreadId } from "@t3tools/contracts";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import * as ServerSettings from "../serverSettings.ts";
import * as SalesService from "./SalesService.ts";

const isSalesActionError = Schema.is(SalesActionError);

/** `GET /summary` as the engine's docs/sales-api.md shows it, plus a field v1 may add later. */
const summaryFixture = {
  version: 1,
  generatedAt: "2026-11-09T18:30:00.000Z",
  day: "2026-11-09",
  timezone: "America/Los_Angeles",
  drafts: {
    awaiting: { total: 2, first: 1, chase: 0, revisit: 0, reply: 1, unknown: 0 },
    approvedWaiting: 1,
    held: 0,
    refused: 1,
  },
  autopilotToday: {
    sent: 1,
    sending: 0,
    retrying: 0,
    failed: 0,
    scheduled: 1,
    held: 1,
    refused: 0,
  },
  linkedin: {
    outstanding: 2,
    onSlack: 1,
    pending: 1,
    budget: {
      day: "2026-11-09",
      timezone: "America/Los_Angeles",
      dailyLimit: 7,
      sentToday: 2,
      externalToday: 1,
      reservedCards: 3,
      readyCards: 3,
      available: 1,
      backlogEnabled: false,
    },
  },
  replies: { awaitingAnswer: 1 },
  needsALook: {
    count: 1,
    capped: false,
    items: [
      {
        what: "bounce-unverified",
        at: "2026-11-09T17:00:00.000Z",
        who: "Ana",
        subject: "creator x fintech",
        why: "Bounce from an address the engine did not send to",
      },
    ],
  },
  sendsToday: {
    cold: 1,
    coldCap: 42,
    firstTouches: 0,
    firstTouchCap: 14,
    replies: 0,
    routeChasesApproved: 0,
    routeChaseCap: 12,
  },
  mailboxes: { active: 8, warming: 0, benched: 1, retired: 0 },
  dispatcher: {
    lastPokeAt: "2026-11-09T18:28:00.000Z",
    pokeAgeSeconds: 120,
    lastTickAt: "2026-11-09T18:29:00.000Z",
    tickAgeSeconds: 60,
    nextTickAt: "2026-11-09T18:31:00.000Z",
    paused: false,
  },
  addedInALaterRelease: { anything: true },
};

/** One open card as `GET /queue` lists it. */
const queueItemFixture = {
  activityId: "act-1",
  kind: "chase",
  step: 2,
  stepLabel: "Email 2",
  contact: {
    id: "contact-1",
    name: "Ana",
    email: "ana@brand.example",
    accountName: "Brand",
    timeZone: "Europe/London",
    effectiveTimeZone: "Europe/London",
    notionUrl: "https://www.notion.so/contact1",
  },
  campaign: "Fintech Q4",
  subject: "Re: creator x fintech",
  threaded: true,
  bodyPreview: "Hey Ana, ...",
  contentHash: "a".repeat(64),
  state: "awaiting",
  approval: null,
  sendAt: null,
  goes: null,
  mailbox: { sticky: true, address: "gabe@trygoodbird.com", threadState: "open" },
  refusal: null,
  note: null,
  check: null,
  skip: null,
  sendStatus: null,
  notionUrl: "https://www.notion.so/act1",
  slack: { channel: "C1", ts: "1.2" },
  rowEditedAt: "2026-11-09T18:00:00.000Z",
};
const queueFixture = {
  version: 1,
  generatedAt: "2026-11-09T18:30:00.000Z",
  timezone: "America/Los_Angeles",
  items: [queueItemFixture],
};

const cardState = {
  activityId: "act-1",
  contentHash: "b".repeat(64),
  state: "open",
  approved: true,
  approvedBy: "device:laptop-1",
  sendAt: "2026-11-10T09:14:00.000Z",
  goes: "Tue 10 Nov, 09:14 their time",
  refusal: null,
  note: null,
};

type Responder = (request: HttpClientRequest.HttpClientRequest) => Response | "network-error";

const pathOf = (request: HttpClientRequest.HttpClientRequest) => new URL(request.url).pathname;
/** The engine's views, answered from the fixtures by path. */
const views: Responder = (request) =>
  pathOf(request).endsWith("/queue") ? Response.json(queueFixture) : Response.json(summaryFixture);
const summaryReads = (requests: ReadonlyArray<HttpClientRequest.HttpClientRequest>) =>
  requests.filter((request) => pathOf(request).endsWith("/summary")).length;

function makeLayer(input: {
  readonly salesEngine?: {
    readonly baseUrl: string;
    readonly readToken: string;
    readonly actionToken?: string;
  };
  readonly respond?: Responder;
  /** Holds each answer back on the test clock, so overlapping reads really overlap. */
  readonly delay?: Duration.Input;
}) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  let respond: Responder = input.respond ?? views;
  const client = HttpClient.make((request) => {
    requests.push(request);
    const response = respond(request);
    return response === "network-error"
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error("ECONNREFUSED"),
            }),
          }),
        )
      : Effect.succeed(HttpClientResponse.fromWeb(request, response)).pipe(
          Effect.delay(input.delay ?? 0),
        );
  });
  const layer = SalesService.layer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provideMerge(
      ServerSettings.layerTest({
        salesEngine: input.salesEngine ?? {
          baseUrl: "https://engine.example.com/",
          readToken: "read-token",
          actionToken: "action-token",
        },
      }),
    ),
  );
  return {
    layer,
    requests,
    setResponder: (next: Responder) => {
      respond = next;
    },
  };
}

/** Subscribes in its own scope and collects events into a queue, so tests await each one. */
const subscribeInScope = Effect.gen(function* () {
  const sales = yield* SalesService.SalesService;
  const scope = yield* Scope.make();
  const events = yield* Queue.unbounded<SalesStreamEvent>();
  const stream = yield* sales.subscribe.pipe(Scope.provide(scope));
  yield* stream.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkIn(scope),
  );
  const nextWith = (predicate: (event: SalesStreamEvent) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(events);
        if (predicate(event)) return event;
      }
    });
  return { scope, nextWith };
});

const isReady = (event: SalesStreamEvent) => event.snapshot.status === "ready";

it.effect("polls the engine only while a client is subscribed", () => {
  // Each summary read reports one more sent today, so every tick changes what subscribers see.
  let reads = 0;
  const { layer, requests } = makeLayer({
    respond: (request) =>
      pathOf(request).endsWith("/summary")
        ? Response.json({
            ...summaryFixture,
            autopilotToday: { ...summaryFixture.autopilotToday, sent: ++reads },
          })
        : views(request),
  });
  return Effect.gen(function* () {
    // Nothing is fetched before anyone subscribes, however long the server runs.
    yield* TestClock.adjust("10 minutes");
    assert.strictEqual(requests.length, 0);

    const first = yield* subscribeInScope;
    const ready = yield* first.nextWith(isReady);
    // Each read asks for the summary and the queue, both on the read token.
    assert.deepStrictEqual(requests.map((request) => request.url).toSorted(), [
      "https://engine.example.com/api/sales/v1/queue",
      "https://engine.example.com/api/sales/v1/summary",
    ]);
    for (const request of requests) {
      assert.strictEqual(request.headers.authorization, "Bearer read-token");
    }
    assert.strictEqual(ready.snapshot.queue?.items[0]?.activityId, "act-1");

    // A second subscriber shares the one poller.
    const second = yield* subscribeInScope;
    yield* TestClock.adjust(SalesService.SALES_POLL_INTERVAL);
    const tick = yield* first.nextWith(
      (event) => event.snapshot.checkedAt !== ready.snapshot.checkedAt,
    );
    yield* second.nextWith((event) => event.snapshot.checkedAt === tick.snapshot.checkedAt);
    assert.strictEqual(requests.length, 4);

    // The poller outlives the first subscriber and stops with the last.
    yield* Scope.close(first.scope, Exit.void);
    yield* TestClock.adjust(SalesService.SALES_POLL_INTERVAL);
    yield* second.nextWith((event) => event.snapshot.checkedAt !== tick.snapshot.checkedAt);
    assert.strictEqual(requests.length, 6);

    yield* Scope.close(second.scope, Exit.void);
    yield* TestClock.adjust("10 minutes");
    assert.strictEqual(requests.length, 6);
  }).pipe(Effect.provide(layer));
});

it.effect("decodes the contract's summary and drops fields it does not know", () => {
  const { layer } = makeLayer({});
  return Effect.gen(function* () {
    const sales = yield* SalesService.SalesService;
    const snapshot = yield* sales.refresh;
    assert.strictEqual(snapshot.status, "ready");
    assert.strictEqual(snapshot.message, null);
    const summary = snapshot.summary;
    assert.isNotNull(summary);
    assert.strictEqual(summary?.drafts.awaiting.total, 2);
    assert.strictEqual(summary?.linkedin.budget.available, 1);
    assert.strictEqual(summary?.needsALook.items[0]?.what, "bounce-unverified");
    assert.strictEqual(summary?.mailboxes.benched, 1);
    assert.strictEqual(summary?.dispatcher.paused, false);
    assert.notProperty(summary ?? {}, "addedInALaterRelease");
    assert.notProperty(summary?.linkedin.budget ?? {}, "externalToday");
    assert.deepStrictEqual(yield* sales.getSnapshot, snapshot);
  }).pipe(Effect.provide(layer));
});

it.effect("fills groups a smaller engine answer leaves out instead of failing", () => {
  const { layer } = makeLayer({
    respond: () => Response.json({ version: 1, generatedAt: "2026-11-09T18:30:00.000Z" }),
  });
  return Effect.gen(function* () {
    const snapshot = yield* (yield* SalesService.SalesService).refresh;
    assert.strictEqual(snapshot.status, "ready");
    assert.strictEqual(snapshot.summary?.drafts.awaiting.total, 0);
    assert.deepStrictEqual(snapshot.summary?.needsALook.items, []);
    assert.deepStrictEqual(snapshot.queue?.items, []);
  }).pipe(Effect.provide(layer));
});

it.effect("maps engine answers to statuses and keeps the last summary through them", () => {
  const { layer, setResponder } = makeLayer({});
  return Effect.gen(function* () {
    const sales = yield* SalesService.SalesService;
    const ready = yield* sales.refresh;
    assert.strictEqual(ready.status, "ready");

    const cases: ReadonlyArray<readonly [Responder, string]> = [
      [
        () =>
          Response.json(
            { error: "sales_api_off", message: "SALES_READ_TOKEN is not set on the engine." },
            { status: 503 },
          ),
        "off",
      ],
      // A 503 that is not the engine's "off" answer is the engine failing.
      [() => new Response("Service Unavailable", { status: 503 }), "failed"],
      [() => Response.json({ error: "unauthorised" }, { status: 401 }), "unauthorised"],
      [() => "network-error", "unreachable"],
      [() => new Response("Internal Server Error", { status: 500 }), "failed"],
      [() => new Response("not json", { status: 200 }), "failed"],
    ];
    for (const [responder, status] of cases) {
      setResponder(responder);
      const snapshot = yield* sales.refresh;
      assert.strictEqual(snapshot.status, status);
      assert.isString(snapshot.message);
      assert.deepStrictEqual(snapshot.summary, ready.summary);
      assert.deepStrictEqual(snapshot.queue, ready.queue);
      assert.strictEqual(snapshot.summaryReadAt, ready.summaryReadAt);
    }
  }).pipe(Effect.provide(layer));
});

it.effect("asks nothing of an engine that is not configured", () => {
  const { layer, requests } = makeLayer({ salesEngine: { baseUrl: "", readToken: "" } });
  return Effect.gen(function* () {
    const snapshot = yield* (yield* SalesService.SalesService).refresh;
    assert.strictEqual(snapshot.status, "not-configured");
    assert.strictEqual(requests.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("reports a URL that is not http(s) without sending it anything", () => {
  const { layer, requests } = makeLayer({
    salesEngine: { baseUrl: "ftp://engine.example.com", readToken: "read-token" },
  });
  return Effect.gen(function* () {
    const snapshot = yield* (yield* SalesService.SalesService).refresh;
    assert.strictEqual(snapshot.status, "failed");
    assert.strictEqual(requests.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("drops the old engine's summary when the settings name a new one", () => {
  const { layer } = makeLayer({});
  return Effect.gen(function* () {
    const sales = yield* SalesService.SalesService;
    const settings = yield* ServerSettings.ServerSettingsService;
    assert.strictEqual((yield* sales.refresh).status, "ready");
    yield* settings.updateSettings({ salesEngine: { readToken: "a-different-token" } });
    const after = yield* sales.refresh;
    assert.strictEqual(after.status, "ready");
    assert.notStrictEqual(after.summaryReadAt, null);
    yield* settings.updateSettings({ salesEngine: { baseUrl: "", readToken: "" } });
    const cleared = yield* sales.refresh;
    assert.strictEqual(cleared.status, "not-configured");
    assert.strictEqual(cleared.summary, null);
  }).pipe(Effect.provide(layer));
});

it.effect("shares one engine request between overlapping reads", () => {
  const { layer, requests } = makeLayer({ delay: "1 second" });
  return Effect.gen(function* () {
    const sales = yield* SalesService.SalesService;
    const overlapping = yield* Effect.all([sales.refresh, sales.refresh], {
      concurrency: "unbounded",
    }).pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    const [a, b] = yield* Fiber.join(overlapping);
    assert.strictEqual(summaryReads(requests), 1);
    assert.deepStrictEqual(a, b);

    // A read after that one finished asks again.
    const later = yield* sales.refresh.pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(later);
    assert.strictEqual(summaryReads(requests), 2);
  }).pipe(Effect.provide(layer));
});

it.effect("replaces a read of the old engine when the settings change during it", () => {
  const { layer, requests } = makeLayer({ delay: "1 second" });
  return Effect.gen(function* () {
    const sales = yield* SalesService.SalesService;
    const settings = yield* ServerSettings.ServerSettingsService;
    // A read of the old engine is in flight when the token changes.
    yield* sales.refresh.pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* settings.updateSettings({ salesEngine: { readToken: "the-new-token" } });
    const replacement = yield* sales.refresh.pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    const after = yield* Fiber.join(replacement);
    assert.strictEqual(after.status, "ready");
    const last = requests.at(-1);
    assert.strictEqual(last?.headers.authorization, "Bearer the-new-token");
    // The old engine's answer never became the snapshot.
    assert.deepStrictEqual(yield* sales.getSnapshot, after);
  }).pipe(Effect.provide(layer));
});

it.effect("drops the old engine's snapshot when the settings change with nobody watching", () => {
  const { layer, requests } = makeLayer({});
  return Effect.gen(function* () {
    const sales = yield* SalesService.SalesService;
    const settings = yield* ServerSettings.ServerSettingsService;
    assert.strictEqual((yield* sales.refresh).status, "ready");
    yield* settings.updateSettings({ salesEngine: { readToken: "the-new-token" } });
    const snapshot = yield* sales.getSnapshot;
    assert.strictEqual(snapshot.summary, null);
    // Nothing was asked of either engine: nobody is watching.
    assert.strictEqual(summaryReads(requests), 1);
  }).pipe(Effect.provide(layer));
});

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.isTrue(Exit.isFailure(exit));
  return Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
};

it.effect("relays actions on the action token and returns the card as it stands", () => {
  const bodies: Array<{ path: string; method: string; body: unknown }> = [];
  const { layer, requests } = makeLayer({
    respond: (request) => {
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : null;
      bodies.push({ path: pathOf(request), method: request.method, body });
      switch (pathOf(request)) {
        case "/api/sales/v1/actions/unapprove":
          return Response.json({ ok: true, ...cardState, approved: false, approvedBy: null });
        case "/api/sales/v1/actions/edit":
          return Response.json({ ok: true, approvalLapsed: true, ...cardState, approved: false });
        case "/api/sales/v1/actions/discard":
          return Response.json({ ok: true, ...cardState, state: "discarded", approved: false });
        default:
          return views(request);
      }
    },
  });
  return Effect.gen(function* () {
    const sales = yield* SalesService.SalesService;
    const unapproved = yield* sales.unapprove("act-1");
    assert.strictEqual(unapproved.approved, false);
    const edited = yield* sales.edit({
      activityId: "act-1",
      expectedHash: "a".repeat(64),
      body: "Hey Ana,\n\nNew words.",
    });
    assert.isTrue(edited.approvalLapsed);
    assert.strictEqual(edited.card.contentHash, cardState.contentHash);
    const discarded = yield* sales.discard({ activityId: "act-1", expectedHash: "b".repeat(64) });
    assert.strictEqual(discarded.state, "discarded");

    for (const request of requests) {
      assert.strictEqual(request.headers.authorization, "Bearer action-token");
      assert.strictEqual(request.method, "POST");
    }
    assert.deepStrictEqual(bodies[1]?.body, {
      activityId: "act-1",
      expectedHash: "a".repeat(64),
      body: "Hey Ana,\n\nNew words.",
    });
    // Nobody was watching, so no action read the queue again.
    assert.strictEqual(summaryReads(requests), 0);
  }).pipe(Effect.provide(layer));
});

it.effect("maps every engine refusal to a typed reason", () => {
  const { layer, setResponder } = makeLayer({});
  return Effect.gen(function* () {
    const sales = yield* SalesService.SalesService;
    const cases: ReadonlyArray<readonly [Responder, string, string | null]> = [
      [
        () =>
          Response.json(
            { error: "stale_hash", message: "Moved on.", currentHash: "c".repeat(64) },
            { status: 409 },
          ),
        "stale_hash",
        "c".repeat(64),
      ],
      [
        () =>
          Response.json({ error: "not_open", message: "Sent.", state: "sent" }, { status: 409 }),
        "not_open",
        null,
      ],
      [
        () =>
          Response.json(
            { error: "changed_in_notion", currentHash: "d".repeat(64) },
            { status: 409 },
          ),
        "changed_in_notion",
        "d".repeat(64),
      ],
      [
        () =>
          Response.json({ error: "notion_failed", currentHash: "e".repeat(64) }, { status: 502 }),
        "notion_failed",
        "e".repeat(64),
      ],
      [
        () => Response.json({ error: "subject_not_editable" }, { status: 400 }),
        "subject_not_editable",
        null,
      ],
      [
        () => Response.json({ error: "sales_actions_off", message: "off" }, { status: 503 }),
        "actions-off",
        null,
      ],
      [() => Response.json({ error: "budget", message: "Out." }, { status: 503 }), "budget", null],
      [() => Response.json({ error: "unauthorised" }, { status: 401 }), "unauthorised", null],
      [() => Response.json({ error: "a_reason_from_later" }, { status: 409 }), "other", null],
      // Whatever its spelling, an engine code is the engine's and never one of Phoenix's reasons.
      [() => Response.json({ error: "not-configured" }, { status: 409 }), "other", null],
      [() => new Response("Internal Server Error", { status: 500 }), "failed", null],
      [() => "network-error", "unreachable", null],
    ];
    for (const [responder, reason, currentHash] of cases) {
      setResponder(responder);
      const error = failureOf(
        yield* sales
          .edit({ activityId: "act-1", expectedHash: "a".repeat(64), body: "x" })
          .pipe(Effect.exit),
      );
      assert.isTrue(isSalesActionError(error));
      if (isSalesActionError(error)) {
        assert.strictEqual(error.reason, reason);
        // Only an answer Phoenix could not read is the transport's; every other came from the engine.
        assert.strictEqual(
          error.origin,
          reason === "failed" || reason === "unreachable" ? "transport" : "engine",
        );
        assert.strictEqual(error.currentHash, currentHash);
        assert.isAbove(error.message.length, 0);
        if (reason === "not_open") assert.strictEqual(error.state, "sent");
      }
    }
  }).pipe(Effect.provide(layer));
});

it.effect("refuses actions without an action token and sends nothing", () => {
  const { layer, requests } = makeLayer({
    salesEngine: { baseUrl: "https://engine.example.com", readToken: "read-token" },
  });
  return Effect.gen(function* () {
    const sales = yield* SalesService.SalesService;
    const error = failureOf(yield* sales.unapprove("act-1").pipe(Effect.exit));
    assert.isTrue(isSalesActionError(error));
    assert.strictEqual(isSalesActionError(error) ? error.reason : null, "not-configured");
    assert.strictEqual(isSalesActionError(error) ? error.origin : null, "phoenix");
    assert.strictEqual(requests.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("relays signed approvals untouched and maps each result in order", () => {
  const items = [
    {
      activityId: "act-1",
      contentHash: "a".repeat(64),
      deviceId: "laptop-1",
      signedAt: "2026-11-10T09:14:03.120Z",
      signature: "sig-1",
    },
    {
      activityId: "act-2",
      contentHash: "f".repeat(64),
      deviceId: "laptop-1",
      signedAt: "2026-11-10T09:14:03.200Z",
      signature: "sig-2",
    },
    {
      activityId: "act-3",
      contentHash: "0".repeat(64),
      deviceId: "laptop-1",
      signedAt: "2026-11-10T09:14:03.300Z",
      signature: "sig-3",
    },
  ];
  let sent: unknown = null;
  const { layer } = makeLayer({
    respond: (request) => {
      if (pathOf(request) !== "/api/sales/v1/actions/approve") return views(request);
      sent =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : null;
      return Response.json({
        results: [
          { ok: true, already: false, ...cardState },
          {
            ok: false,
            activityId: "act-2",
            reason: "stale_hash",
            message: "Moved on.",
            currentHash: "9".repeat(64),
          },
          { ok: false, activityId: "act-3", reason: "a_reason_from_later", message: "New." },
        ],
        approved: 1,
        failed: 2,
      });
    },
  });
  return Effect.gen(function* () {
    const result = yield* (yield* SalesService.SalesService).approve({ items });
    // The server forwards the client's signatures byte for byte.
    assert.deepStrictEqual(sent, { items });
    assert.deepStrictEqual(result.results, [
      { ok: true, already: false, card: cardState },
      {
        ok: false,
        activityId: "act-2",
        reason: "stale_hash",
        message: "Moved on.",
        currentHash: "9".repeat(64),
      },
      { ok: false, activityId: "act-3", reason: "other", message: "New.", currentHash: null },
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("never reads a missing approval result as approved", () => {
  const { layer } = makeLayer({
    respond: (request) =>
      pathOf(request) === "/api/sales/v1/actions/approve"
        ? Response.json({ results: [], approved: 0, failed: 0 })
        : views(request),
  });
  return Effect.gen(function* () {
    const result = yield* (yield* SalesService.SalesService).approve({
      items: [
        {
          activityId: "act-1",
          contentHash: "a".repeat(64),
          deviceId: "d",
          signedAt: "2026-11-10T09:14:03.120Z",
          signature: "s",
        },
      ],
    });
    assert.strictEqual(result.results[0]?.ok, false);
  }).pipe(Effect.provide(layer));
});

it.effect("reads the queue again after an action while someone watches", () => {
  let unapproved = false;
  const { layer, requests } = makeLayer({
    respond: (request) => {
      if (pathOf(request) === "/api/sales/v1/actions/unapprove") {
        unapproved = true;
        return Response.json({ ok: true, ...cardState, approved: false });
      }
      // After the action the engine reports the card in another state.
      return unapproved && pathOf(request).endsWith("/queue")
        ? Response.json({ ...queueFixture, items: [{ ...queueItemFixture, state: "held" }] })
        : views(request);
    },
  });
  return Effect.gen(function* () {
    const sales = yield* SalesService.SalesService;
    const watcher = yield* subscribeInScope;
    const ready = yield* watcher.nextWith(isReady);
    assert.strictEqual(summaryReads(requests), 1);
    assert.strictEqual(ready.snapshot.status, "ready");
    // The action itself publishes nothing, so the next event is the read it set off.
    yield* sales.unapprove("act-1");
    yield* watcher.nextWith(() => true);
    assert.strictEqual(summaryReads(requests), 2);
    yield* Scope.close(watcher.scope, Exit.void);
  }).pipe(Effect.provide(layer));
});

it.effect("keeps dispatches through engine reads and settings changes", () => {
  const { layer } = makeLayer({});
  return Effect.gen(function* () {
    const sales = yield* SalesService.SalesService;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* sales.recordDispatch({
      target: "act-1",
      action: "redraft",
      skill: "follow-up-drafting",
      threadId: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Redraft for Ana",
      startedAt: "2026-11-10T09:00:00.000Z",
    });
    assert.strictEqual((yield* sales.refresh).dispatches.length, 1);
    yield* settings.updateSettings({ salesEngine: { readToken: "the-new-token" } });
    assert.strictEqual((yield* sales.getSnapshot).dispatches[0]?.threadId, "thread-1");
  }).pipe(Effect.provide(layer));
});

it.effect("sends subscribers nothing when a poll finds nothing new", () => {
  let changed = false;
  const { layer, requests } = makeLayer({
    respond: (request) =>
      pathOf(request).endsWith("/queue")
        ? Response.json({
            ...queueFixture,
            // The engine stamps every answer; a new stamp alone is not news.
            generatedAt: `2026-11-09T18:3${summaryReads(requests)}:00.000Z`,
            items: changed ? [] : [queueItemFixture],
          })
        : Response.json({
            ...summaryFixture,
            generatedAt: `2026-11-09T18:3${summaryReads(requests)}:00.000Z`,
          }),
  });
  return Effect.gen(function* () {
    const sales = yield* SalesService.SalesService;
    const watcher = yield* subscribeInScope;
    yield* watcher.nextWith(isReady);
    // A read that finds the same drafts updates the snapshot but sends nothing.
    const same = yield* sales.refresh;
    assert.strictEqual(summaryReads(requests), 2);
    assert.strictEqual(same.queue?.items.length, 1);
    // So the next event a subscriber gets is the read that changed something.
    changed = true;
    yield* sales.refresh;
    const next = yield* watcher.nextWith(() => true);
    assert.strictEqual(next.snapshot.queue?.items.length, 0);
    yield* Scope.close(watcher.scope, Exit.void);
  }).pipe(Effect.provide(layer));
});
