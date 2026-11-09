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
import type { SalesStreamEvent } from "@t3tools/contracts";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import * as ServerSettings from "../serverSettings.ts";
import * as SalesService from "./SalesService.ts";

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

type Responder = (request: HttpClientRequest.HttpClientRequest) => Response | "network-error";

function makeLayer(input: {
  readonly salesEngine?: { readonly baseUrl: string; readonly readToken: string };
  readonly respond?: Responder;
  /** Holds each answer back on the test clock, so overlapping reads really overlap. */
  readonly delay?: Duration.Input;
}) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  let respond: Responder = input.respond ?? (() => Response.json(summaryFixture));
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
  const { layer, requests } = makeLayer({});
  return Effect.gen(function* () {
    // Nothing is fetched before anyone subscribes, however long the server runs.
    yield* TestClock.adjust("10 minutes");
    assert.strictEqual(requests.length, 0);

    const first = yield* subscribeInScope;
    const ready = yield* first.nextWith(isReady);
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0]?.url, "https://engine.example.com/api/sales/v1/summary");
    assert.strictEqual(requests[0]?.headers.authorization, "Bearer read-token");

    // A second subscriber shares the one poller.
    const second = yield* subscribeInScope;
    yield* TestClock.adjust(SalesService.SALES_POLL_INTERVAL);
    const tick = yield* first.nextWith(
      (event) => event.snapshot.checkedAt !== ready.snapshot.checkedAt,
    );
    yield* second.nextWith((event) => event.snapshot.checkedAt === tick.snapshot.checkedAt);
    assert.strictEqual(requests.length, 2);

    // The poller outlives the first subscriber and stops with the last.
    yield* Scope.close(first.scope, Exit.void);
    yield* TestClock.adjust(SalesService.SALES_POLL_INTERVAL);
    yield* second.nextWith((event) => event.snapshot.checkedAt !== tick.snapshot.checkedAt);
    assert.strictEqual(requests.length, 3);

    yield* Scope.close(second.scope, Exit.void);
    yield* TestClock.adjust("10 minutes");
    assert.strictEqual(requests.length, 3);
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
    assert.strictEqual(requests.length, 1);
    assert.deepStrictEqual(a, b);

    // A read after that one finished asks again.
    const later = yield* sales.refresh.pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(later);
    assert.strictEqual(requests.length, 2);
  }).pipe(Effect.provide(layer));
});
