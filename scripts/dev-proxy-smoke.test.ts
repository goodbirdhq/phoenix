// @effect-diagnostics nodeBuiltinImport:off - this test drives real HTTP and
// WebSocket upgrade sockets through Vite's proxy.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { createServer as createViteServer } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";

import { createDevProxyEntries } from "@t3tools/shared/devProxy";
import { createDevRunnerEnv } from "./dev-runner.ts";

const listen = (server: NodeHttp.Server) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Expected a TCP listener address."));
        return;
      }
      resolve(address.port);
    });
  });

const close = (server: NodeHttp.Server | NodeNet.Server) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

const request = (port: number, path: string) =>
  new Promise<{ body: string; statusCode: number | undefined }>((resolve, reject) => {
    const client = NodeHttp.get({ host: "127.0.0.1", port, path }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolve({ body, statusCode: response.statusCode }));
    });
    client.on("error", reject);
  });

const requestUpgrade = (port: number) =>
  new Promise<string>((resolve, reject) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setTimeout(5_000, () => socket.destroy(new Error("Timed out waiting for upgrade.")));
    socket.on("connect", () => {
      socket.write(
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.includes("\r\n\r\n")) socket.end();
    });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });

describe("dev-runner single-origin proxy", () => {
  it("forwards an HTTP request and websocket upgrade through the runner's backend port", async () => {
    const backend = NodeHttp.createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`backend:${request.url}`);
    });
    backend.on("upgrade", (_request, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n",
      );
      socket.end();
    });

    const backendPort = await listen(backend);
    const env = await Effect.runPromise(
      createDevRunnerEnv({
        mode: "dev",
        baseEnv: {},
        serverOffset: 0,
        webOffset: 0,
        t3Home: undefined,
        browser: false,
        autoBootstrapProjectFromCwd: undefined,
        logWebSocketEvents: undefined,
        host: undefined,
        port: backendPort,
        devUrl: undefined,
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    const proxy = createDevProxyEntries(`http://127.0.0.1:${env.T3CODE_PORT}/`);
    expect(Object.keys(proxy ?? {})).toEqual(["/api", "/oauth", "/.well-known", "/ws"]);
    if (!proxy) throw new Error("Expected browser development proxy entries.");

    const vite = await createViteServer({
      configFile: false,
      appType: "spa",
      server: { host: "127.0.0.1", port: 0, proxy },
    });
    try {
      await vite.listen();
      const address = vite.httpServer?.address();
      if (address === null || address === undefined || typeof address === "string") {
        throw new Error("Expected Vite to expose a TCP listener.");
      }

      const response = await request(address.port, "/.well-known/smoke");
      const upgrade = await requestUpgrade(address.port);
      expect(response).toEqual({ body: "backend:/.well-known/smoke", statusCode: 200 });
      expect(upgrade).toContain("101 Switching Protocols");
    } finally {
      await vite.close();
      await close(backend);
    }
  });
});
