import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPhoenixClient,
  PhoenixAuthError,
  PhoenixClientError,
  PhoenixDispatchFailedError,
  PhoenixInvalidRequestError,
  PhoenixUnreachableError,
} from "./client.ts";

// Birdhouse's only network boundary, and the one place a Phoenix contract
// change lands at runtime rather than at typecheck (the wire shapes are
// hand-transcribed — see docs/internals/birdhouse.md). These pin the error
// taxonomy the job handlers branch on: which failures are terminal, which are
// retryable, and which are neither.
describe("createPhoenixClient", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  /** Serves one canned response and records what it was sent. */
  async function serve(handler: (path: string, body: string) => { status: number; body: string }) {
    const received: { path: string; authorization?: string; body: unknown }[] = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        received.push({
          path: req.url ?? "",
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
          body: raw ? JSON.parse(raw) : undefined,
        });
        const response = handler(req.url ?? "", raw);
        res.writeHead(response.status, { "Content-Type": "application/json" });
        res.end(response.body);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server!.address() as AddressInfo;
    return { received, baseUrl: `http://127.0.0.1:${port}` };
  }

  /** `null` means "no token configured" — distinct from omitting the argument. */
  function clientFor(baseUrl: string, token: string | null = "test-token") {
    return createPhoenixClient({
      PHOENIX_BASE_URL: baseUrl,
      ...(token !== null ? { PHOENIX_BIRDHOUSE_TOKEN: token } : {}),
    } as Parameters<typeof createPhoenixClient>[0]);
  }

  it("sends the bearer token and returns the dispatch sequence", async () => {
    const { received, baseUrl } = await serve(() => ({
      status: 200,
      body: JSON.stringify({ sequence: 7 }),
    }));
    const client = clientFor(baseUrl);

    const command = client.createThread({
      commandId: "cmd-1",
      threadId: "thread-1",
      projectId: "project-1",
      title: "Test",
      modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5" },
      runtimeMode: "auto",
    });
    expect(await client.dispatch(command)).toEqual({ sequence: 7 });
    expect(received[0]?.path).toBe("/api/orchestration/dispatch");
    expect(received[0]?.authorization).toBe("Bearer test-token");
    expect(received[0]?.body).toMatchObject({ type: "thread.create", commandId: "cmd-1" });
  });

  it("fails fast without a configured token, before any request", async () => {
    const { received, baseUrl } = await serve(() => ({ status: 200, body: "{}" }));
    await expect(clientFor(baseUrl, null).getThread("thread-1")).rejects.toBeInstanceOf(
      PhoenixAuthError,
    );
    expect(received).toEqual([]);
  });

  // The handlers treat 400 as terminal (a rejected commandId can never be
  // regenerated) and everything else as retryable, so this mapping is
  // load-bearing for whether a run fails outright or is retried.
  it.each([
    [400, PhoenixInvalidRequestError],
    [401, PhoenixAuthError],
    [403, PhoenixAuthError],
    [500, PhoenixDispatchFailedError],
    [404, PhoenixClientError],
  ])("maps HTTP %i onto its own error type", async (status, expected) => {
    const { baseUrl } = await serve(() => ({
      status,
      body: JSON.stringify({ reason: "nope", traceId: "trace-1" }),
    }));
    await expect(clientFor(baseUrl).getThread("thread-1")).rejects.toBeInstanceOf(expected);
  });

  it("defaults a thread detail payload's optional fields rather than throwing", async () => {
    const { baseUrl } = await serve(() => ({
      status: 200,
      body: JSON.stringify({ thread: { id: "thread-1" } }),
    }));
    expect(await clientFor(baseUrl).getThread("thread-1")).toEqual({
      id: "thread-1",
      session: null,
      latestTurn: null,
      reports: [],
    });
  });

  it("treats a response with no thread object as Phoenix being unreachable", async () => {
    const { baseUrl } = await serve(() => ({ status: 200, body: JSON.stringify({}) }));
    await expect(clientFor(baseUrl).getThread("thread-1")).rejects.toBeInstanceOf(
      PhoenixUnreachableError,
    );
  });

  it("reports a failed stop instead of swallowing it", async () => {
    const { baseUrl } = await serve(() => ({
      status: 403,
      body: JSON.stringify({
        reason: "insufficient_scope",
        requiredScope: "orchestration:operate",
      }),
    }));
    // A stop that never lands leaves an agent session running; the
    // workflow.stop job needs the throw to know to retry.
    await expect(clientFor(baseUrl).stopSession("thread-1")).rejects.toBeInstanceOf(
      PhoenixAuthError,
    );
  });
});
