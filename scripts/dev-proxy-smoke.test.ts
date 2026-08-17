// @effect-diagnostics nodeBuiltinImport:off - this test drives real HTTP and
// WebSocket upgrade sockets through Vite's proxy.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createServer as createViteServer } from "vite-plus";

import { createDevRunnerEnv } from "./dev-runner.ts";

const webRoot = NodeURL.fileURLToPath(new URL("../apps/web", import.meta.url));
const webViteConfig = NodePath.join(webRoot, "vite.config.ts");

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

it.layer(NodeServices.layer)("dev-runner single-origin proxy", (it) => {
  it.effect(
    "forwards an HTTP request and websocket upgrade through the runner's backend port",
    () =>
      Effect.gen(function* () {
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

        const backendPort = yield* Effect.promise(() => listen(backend));
        const env = yield* createDevRunnerEnv({
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
        });
        const originalEnvironment = {
          T3CODE_PORT: process.env.T3CODE_PORT,
          T3CODE_SINGLE_ORIGIN_DEV: process.env.T3CODE_SINGLE_ORIGIN_DEV,
          T3CODE_BUNDLED_DEV: process.env.T3CODE_BUNDLED_DEV,
          PORT: process.env.PORT,
        };
        Object.assign(process.env, env, {
          T3CODE_SINGLE_ORIGIN_DEV: "1",
          T3CODE_BUNDLED_DEV: "0",
          PORT: "0",
        });

        // Load the production dev config rather than rebuilding a lookalike
        // proxy map in this test. This proves Vite receives both HTTP and WebSocket
        // forwarding rules from the configuration browser development actually runs.
        let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
        yield* Effect.promise(async () => {
          try {
            vite = await createViteServer({
              root: webRoot,
              configFile: webViteConfig,
            });
            await vite.listen();
            const address = vite.httpServer?.address();
            if (address === null || address === undefined || typeof address === "string") {
              throw new Error("Expected Vite to expose a TCP listener.");
            }

            const response = await request(address.port, "/.well-known/smoke");
            const upgrade = await requestUpgrade(address.port);
            assert.deepStrictEqual(response, {
              body: "backend:/.well-known/smoke",
              statusCode: 200,
            });
            assert.match(upgrade, /101 Switching Protocols/u);
          } finally {
            await vite?.close();
            await close(backend);
            for (const [key, value] of Object.entries(originalEnvironment)) {
              if (value === undefined) delete process.env[key];
              else process.env[key] = value;
            }
          }
        });
      }),
  );
});
