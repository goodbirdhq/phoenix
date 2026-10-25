// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Desktop-only bounded native loopback listener.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";

const cleanupScript = "history.replaceState(null, '', '/cloud/callback')";
const cleanupScriptHash = NodeCrypto.createHash("sha256").update(cleanupScript).digest("base64");

/** Tokens and PKCE remain on the selected environment; this listener receives its OAuth response. */
export async function preparePhoenixCloudCallback() {
  const response = Promise.withResolvers<string>();
  void response.promise.catch(() => undefined);
  let redirectUri = "";
  let expectedState: string | undefined;
  let expectedIssuer: string | undefined;
  let receiving = false;
  let closed = false;
  const server = NodeHttp.createServer((request, reply) => {
    reply.setHeader("cache-control", "no-store");
    reply.setHeader("referrer-policy", "no-referrer");
    reply.setHeader("x-content-type-options", "nosniff");
    try {
      const url = new URL(request.url ?? "/", redirectUri);
      const single = (key: string) => {
        const values = url.searchParams.getAll(key);
        return values.length === 1 && values[0] ? values[0] : undefined;
      };
      if (
        request.method !== "GET" ||
        (request.url?.length ?? 0) > 16_384 ||
        url.username ||
        url.password ||
        !expectedState ||
        url.origin !== new URL(redirectUri).origin ||
        url.pathname !== "/cloud/callback" ||
        url.hash ||
        single("state") !== expectedState ||
        single("iss") !== expectedIssuer ||
        Boolean(single("code")) === Boolean(single("error")) ||
        url.searchParams.getAll("code").length > 1 ||
        url.searchParams.getAll("error").length > 1
      )
        throw new Error("foreign response");
      reply.setHeader(
        "content-security-policy",
        `default-src 'none'; script-src 'sha256-${cleanupScriptHash}'; frame-ancestors 'none'`,
      );
      reply
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(
          `<!doctype html><title>Phoenix</title><h1>Return to Phoenix</h1><p>Your response has been received. Phoenix is finishing the connection.</p><script>${cleanupScript}</script>`,
          () => response.resolve(url.toString()),
        );
      expectedState = undefined;
    } catch {
      reply.writeHead(400).end("This response does not belong to the active sign-in.");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not prepare Phoenix sign-in.");
  redirectUri = `http://127.0.0.1:${address.port}/cloud/callback`;
  const cancel = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    expectedState = undefined;
    response.reject(new Error("Phoenix Cloud sign-in was cancelled or expired. Try again."));
    server.closeAllConnections();
    server.close();
  };
  const timer = setTimeout(cancel, 600_000);
  timer.unref();
  return {
    redirectUri,
    cancel,
    async receive(authorizationUrl: string, openBrowser: (url: string) => Promise<boolean>) {
      if (closed || receiving)
        throw new Error("This Phoenix Cloud sign-in is no longer available.");
      receiving = true;
      try {
        const url = new URL(authorizationUrl);
        const single = (key: string) => {
          const values = url.searchParams.getAll(key);
          return values.length === 1 ? values[0] : undefined;
        };
        if (
          authorizationUrl.length > 16_384 ||
          url.username ||
          url.password ||
          url.hash ||
          !(
            url.protocol === "https:" ||
            (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
          ) ||
          single("redirect_uri") !== redirectUri ||
          !single("state") ||
          single("response_type") !== "code" ||
          single("code_challenge_method") !== "S256" ||
          !/^[\w-]{43}$/u.test(single("code_challenge") ?? "")
        )
          throw new Error("Invalid Phoenix Cloud sign-in request.");
        expectedState = single("state");
        expectedIssuer = `${url.origin}/api/auth`;
        if (!(await openBrowser(url.toString())))
          throw new Error("Could not open the sign-in browser.");
        return await response.promise;
      } finally {
        cancel();
      }
    },
  };
}
