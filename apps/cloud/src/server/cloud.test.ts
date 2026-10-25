import * as NodeFSP from "node:fs/promises";
import { eq, inArray } from "drizzle-orm";
import { createInstallationStore } from "./installations";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as schema from "../db/schema";
import { createCloudStore } from "./store";
import { createAuth } from "./create-auth";

const pg = new PGlite();
const db = drizzle(pg, { schema });
const store = createCloudStore(db);
const auth = createAuth(db, {
  secret: "test-only-8aa1b258c2c14c67853a4cf90d01159d",
  baseURL: "http://localhost:3100",
});

beforeAll(async () => {
  for (const file of (await NodeFSP.readdir(new URL("../../drizzle/", import.meta.url)))
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    await pg.exec(
      await NodeFSP.readFile(new URL(`../../drizzle/${file}`, import.meta.url), "utf8"),
    );
  }
});
beforeEach(async () => {
  await pg.exec(
    'TRUNCATE TABLE "rate_limit", "device_code", "cloud_installation_request", "oauth_client" CASCADE',
  );
  await pg.exec('TRUNCATE TABLE "user" CASCADE');
  await db.insert(schema.user).values([
    { id: "alice", name: "Alice", email: "alice@example.com" },
    { id: "bob", name: "Bob", email: "bob@example.com" },
  ]);
});
afterAll(() => pg.close());

describe("cloud workspace ownership", () => {
  it("persists create and rename, rejects foreign mutations, and deletes only the owner's workspace", async () => {
    const alice = await store.createWorkspace("alice", {
      name: "  Design system  ",
      ownerId: "bob",
    });
    const bob = await store.createWorkspace("bob", { name: "Server" });
    expect(alice.ownerId).toBe("alice");
    expect(alice.name).toBe("Design system");
    expect((await store.listWorkspaces("alice")).map((row) => row.id)).toEqual([alice.id]);
    expect((await store.listWorkspaces("bob")).map((row) => row.id)).toEqual([bob.id]);
    await expect(store.renameWorkspace("bob", { id: alice.id, name: "Stolen" })).rejects.toThrow(
      "Workspace not found",
    );
    await expect(store.deleteWorkspace("bob", { id: alice.id })).rejects.toThrow(
      "Workspace not found",
    );
    await store.renameWorkspace("alice", { id: alice.id, name: "  Client library  " });
    expect((await store.listWorkspaces("alice"))[0]?.name).toBe("Client library");
    await store.deleteWorkspace("alice", { id: alice.id });
    expect(await store.listWorkspaces("alice")).toEqual([]);
    expect((await store.listWorkspaces("bob"))[0]?.id).toBe(bob.id);
  });
  it("rejects invalid names and identifiers before writing", async () => {
    await expect(store.createWorkspace("alice", { name: "  " })).rejects.toThrow();
    await expect(store.createWorkspace("alice", { name: "x".repeat(81) })).rejects.toThrow();
    await expect(
      store.renameWorkspace("alice", { id: "invalid", name: "Valid" }),
    ).rejects.toThrow();
    expect(await store.listWorkspaces("alice")).toEqual([]);
  });
});

describe("installation registration foundation", () => {
  it("starts empty, stores typed installations under the current owner, and scopes removal", async () => {
    expect(await store.listInstallations("alice")).toEqual([]);
    const desktop = await store.registerInstallation("alice", {
      name: "Laptop",
      kind: "desktop",
      ownerId: "bob",
    });
    const remote = await store.registerInstallation("alice", {
      name: "Build server",
      kind: "remote-server",
    });
    expect(desktop.ownerId).toBe("alice");
    expect((await store.listInstallations("alice")).map((row) => row.kind).sort()).toEqual([
      "desktop",
      "remote-server",
    ]);
    expect(await store.listInstallations("bob")).toEqual([]);
    await expect(store.deleteInstallation("bob", { id: desktop.id })).rejects.toThrow("not found");
    await store.deleteInstallation("alice", { id: desktop.id });
    expect((await store.listInstallations("alice")).map((row) => row.id)).toEqual([remote.id]);
    await expect(
      store.registerInstallation("alice", { name: "Phone", kind: "mobile" }),
    ).rejects.toThrow();
  });
});

function authRequest(path: string, body?: object, cookie?: string) {
  return auth.handler(
    new Request(`http://localhost:3100/api/auth/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type":
          path === "oauth2/token" ? "application/x-www-form-urlencoded" : "application/json",
        Origin: "http://localhost:3100",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body
        ? {
            body:
              path === "oauth2/token"
                ? new URLSearchParams(
                    Object.entries(body).map(([key, value]) => [key, String(value)]),
                  ).toString()
                : JSON.stringify(body),
          }
        : {}),
    }),
  );
}
function responseCookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

describe("email and password authentication", () => {
  it("accepts the same invite code for multiple accounts", async () => {
    for (const email of ["first-invite@example.com", "second-invite@example.com"]) {
      const response = await authRequest("sign-up/email", {
        name: "Invited user",
        email,
        password: "a-long-test-password",
        inviteCode: "268923",
      });
      expect(response.status).toBe(200);
      expect(responseCookie(response)).toContain("session_token");
    }
  });
  it("rejects missing and incorrect invite codes without creating an account or session", async () => {
    for (const inviteCode of [undefined, "", "000000", 268923]) {
      await pg.exec('TRUNCATE TABLE "rate_limit"');
      const response = await authRequest("sign-up/email", {
        name: "Invited user",
        email: "invite@example.com",
        password: "a-long-test-password",
        inviteCode,
      });
      expect(response.status).toBe(400);
      expect((await response.json()).message).toBe("Enter a valid invite code.");
      expect(responseCookie(response)).not.toContain("session_token");
    }
    expect((await db.select().from(schema.user)).map((row) => row.id).sort()).toEqual([
      "alice",
      "bob",
    ]);
    expect(await db.select().from(schema.session)).toEqual([]);
  });

  it("signs up, persists an authenticated session, rejects incorrect passwords, logs out, and logs back in", async () => {
    const signedUp = await authRequest("sign-up/email", {
      name: "Charlie",
      email: "charlie@example.com",
      password: "a-long-test-password",
      inviteCode: "268923",
    });
    expect(signedUp.status).toBe(200);
    const cookie = responseCookie(signedUp);
    expect(cookie).toContain("session_token");
    const session = await authRequest("get-session", undefined, cookie);
    expect((await session.json()).user.email).toBe("charlie@example.com");
    const wrongPassword = await authRequest("sign-in/email", {
      email: "charlie@example.com",
      password: "incorrect-password",
    });
    expect(wrongPassword.status).toBe(401);
    const signedOut = await authRequest("sign-out", {}, cookie);
    expect(signedOut.status).toBe(200);
    expect(await (await authRequest("get-session", undefined, cookie)).json()).toBeNull();
    const signedIn = await authRequest("sign-in/email", {
      email: "charlie@example.com",
      password: "a-long-test-password",
    });
    expect(signedIn.status).toBe(200);
    expect(
      (await (await authRequest("get-session", undefined, responseCookie(signedIn))).json()).user
        .email,
    ).toBe("charlie@example.com");
    expect(await (await authRequest("get-session")).json()).toBeNull();
  });
  it("rejects duplicate accounts and short passwords", async () => {
    const first = await authRequest("sign-up/email", {
      name: "Charlie",
      email: "charlie@example.com",
      password: "a-long-test-password",
      inviteCode: "268923",
    });
    expect(first.status).toBe(200);
    expect(
      (
        await authRequest("sign-up/email", {
          name: "Charlie",
          email: "charlie@example.com",
          password: "a-long-test-password",
          inviteCode: "268923",
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await authRequest("sign-up/email", {
          name: "Short",
          email: "short@example.com",
          password: "short",
          inviteCode: "268923",
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
  });
});

async function cloudSignup(email = "owner@example.com") {
  const response = await authRequest("sign-up/email", {
    name: "Owner",
    email,
    password: "a-long-test-password",
    inviteCode: "268923",
  });
  expect(response.status).toBe(200);
  return responseCookie(response);
}
async function beginInstallation() {
  const registered = await authRequest("installation/register", {
    installation_id: "86c897b4-f8fb-4c17-bc87-f291c3c3917a",
    name: "My laptop",
    kind: "desktop",
  });
  expect(registered.status).toBe(200);
  const client = await registered.json();
  const response = await authRequest("device/code", {
    client_id: client.client_id,
    scope: "installation offline_access",
  });
  expect(response.status).toBe(200);
  return { ...(await response.json()), ...client };
}
function pollInstallation(grant: { client_id: string; device_code: string }) {
  return authRequest("oauth2/token", {
    client_id: grant.client_id,
    device_code: grant.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
}
async function approveInstallation(grant: { user_code: string }, cookie: string) {
  expect((await authRequest(`device?user_code=${grant.user_code}`, undefined, cookie)).status).toBe(
    200,
  );
  const response = await authRequest("device/approve", { userCode: grant.user_code }, cookie);
  expect(response.status).toBe(200);
}
function installationRequest(path: string, token?: string, method = "GET") {
  return auth.handler(
    new Request(`http://localhost:3100/api/auth/installation/${path}`, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );
}

describe("installation OAuth device authorization", () => {
  it("binds approval to a signed-in owner, issues scoped credentials once, and revokes access and refresh tokens", async () => {
    const owner = await cloudSignup();
    const other = await cloudSignup("other@example.com");
    const grant = await beginInstallation();
    expect(grant.interval).toBe(5);
    expect(grant.expires_in).toBe(600);
    expect((await authRequest("device/approve", { userCode: grant.user_code })).status).toBe(401);
    await authRequest(`device?user_code=${grant.user_code}`, undefined, owner);
    expect(
      (await authRequest("device/approve", { userCode: grant.user_code }, other)).status,
    ).toBeGreaterThanOrEqual(400);
    const anotherSession = await authRequest("sign-in/email", {
      email: "owner@example.com",
      password: "a-long-test-password",
    });
    expect(anotherSession.status).toBe(200);
    const ownerInAnotherSession = responseCookie(anotherSession);
    expect(ownerInAnotherSession).not.toBe(owner);
    await approveInstallation(grant, ownerInAnotherSession);
    const response = await pollInstallation(grant);
    expect(response.status).toBe(200);
    const tokens = await response.json();
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.scope).toContain("installation");
    expect(responseCookie(response)).not.toContain("session_token");
    expect((await (await pollInstallation(grant)).json()).error).toBe("invalid_grant");
    const current = await installationRequest("current", tokens.access_token);
    expect(current.status).toBe(200);
    const details = await current.json();
    expect(details.installation).toMatchObject({
      name: "My laptop",
      kind: "desktop",
      installationId: "86c897b4-f8fb-4c17-bc87-f291c3c3917a",
      lastSeenAt: null,
    });
    expect(details.user.email).toBe("owner@example.com");
    expect((await installationRequest("current")).status).toBe(401);
    expect(
      await (
        await authRequest(
          "get-session",
          undefined,
          `better-auth.session_token=${tokens.access_token}`,
        )
      ).json(),
    ).toBeNull();
    const { createInstallationStore } = await import("./installations");
    const devices = createInstallationStore(db);
    await expect(devices.revoke("bob", details.installation.id)).rejects.toThrow();
    await expect(devices.details(details.installation.id, "bob")).rejects.toThrow();
    const heartbeat = await installationRequest("heartbeat", tokens.access_token, "POST");
    expect(heartbeat.status).toBe(200);
    expect((await heartbeat.json()).installation.lastSeenAt).toBeTruthy();
    expect((await installationRequest("disconnect", tokens.access_token, "POST")).status).toBe(204);
    expect((await installationRequest("current", tokens.access_token)).status).toBe(401);
    const refresh = await authRequest("oauth2/token", {
      client_id: grant.client_id,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    expect(refresh.status).toBeGreaterThanOrEqual(400);
    expect(
      (
        await authRequest("device/code", {
          client_id: grant.client_id,
          scope: "installation offline_access",
        })
      ).status,
    ).toBe(400);
  });
  it("enforces polling limits and denial", async () => {
    const cookie = await cloudSignup();
    const grant = await beginInstallation();
    expect((await (await pollInstallation(grant)).json()).error).toBe("authorization_pending");
    expect((await (await pollInstallation(grant)).json()).error).toBe("slow_down");
    await authRequest(`device?user_code=${grant.user_code}`, undefined, cookie);
    expect((await authRequest("device/deny", { userCode: grant.user_code }, cookie)).status).toBe(
      200,
    );
    await db.update(schema.deviceCode).set({ lastPolledAt: null });
    expect((await (await pollInstallation(grant)).json()).error).toBe("access_denied");
    expect(
      await store.listInstallations(
        (await (await authRequest("get-session", undefined, cookie)).json()).user.id,
      ),
    ).toEqual([]);
  });
  it("rejects expired grants, unauthorized claim access, wrong clients and session-token redemption", async () => {
    const cookie = await cloudSignup();
    const grant = await beginInstallation();
    expect(
      (await (await authRequest(`device?user_code=${grant.user_code}`)).json()).client_id,
    ).toBeUndefined();
    const other = await beginInstallation();
    expect(
      (await (await pollInstallation({ ...grant, client_id: other.client_id })).json()).error,
    ).toBe("invalid_grant");
    await approveInstallation(grant, cookie);
    const standalone = await authRequest("device/token", {
      client_id: grant.client_id,
      device_code: grant.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    expect(standalone.status).toBeGreaterThanOrEqual(400);
    await db
      .update(schema.deviceCode)
      .set({ expiresAt: new Date("2000-01-01T00:00:00Z"), lastPolledAt: null });
    expect(
      (await authRequest("device/approve", { userCode: other.user_code }, cookie)).status,
    ).toBeGreaterThanOrEqual(400);
    expect((await (await pollInstallation(grant)).json()).error).toBe("expired_token");
    expect((await (await pollInstallation(other)).json()).error).toBe("expired_token");
  });
  it("consumes simultaneous redemptions once and recovers an unfinished approval projection", async () => {
    const cookie = await cloudSignup();
    const grant = await beginInstallation();
    await approveInstallation(grant, cookie);
    await db.delete(schema.installation);
    const responses = await Promise.all([pollInstallation(grant), pollInstallation(grant)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const success = responses.find((response) => response.status === 200)!;
    const tokens = await success.json();
    expect((await installationRequest("current", tokens.access_token)).status).toBe(200);
  });
  it("rejects authorization-code grants and arbitrary public OAuth registration", async () => {
    const grant = await beginInstallation();
    const response = await authRequest("oauth2/token", {
      client_id: grant.client_id,
      grant_type: "authorization_code",
      code: "unissued-code",
      redirect_uri: "https://example.com/callback",
      code_verifier: "a".repeat(43),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("unauthorized_client");
    const registration = await authRequest("oauth2/register", {
      client_name: "Untrusted app",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      redirect_uris: ["https://example.com/callback"],
    });
    expect(registration.status).toBe(403);
    expect(await db.select().from(schema.oauthClient)).toHaveLength(1);
  });
  it("cleans abandoned registrations while preserving live grants, claims and approved installations", async () => {
    const devices = createInstallationStore(db);
    const cookie = await cloudSignup();
    const expired = await beginInstallation();
    const live = await beginInstallation();
    const claimed = await beginInstallation();
    await authRequest(`device?user_code=${claimed.user_code}`, undefined, cookie);
    const approved = await beginInstallation();
    await approveInstallation(approved, cookie);
    const noGrant = await devices.register({
      installation_id: "86c897b4-f8fb-4c17-bc87-f291c3c3917a",
      name: "Abandoned",
      kind: "desktop",
    });
    await db
      .update(schema.installationRequest)
      .set({ createdAt: new Date("2000-01-01T00:00:00Z") });
    await db
      .update(schema.deviceCode)
      .set({ expiresAt: new Date("2000-01-01T00:00:00Z") })
      .where(
        inArray(schema.deviceCode.clientId, [
          expired.client_id,
          claimed.client_id,
          approved.client_id,
        ]),
      );
    await devices.register({
      installation_id: "86c897b4-f8fb-4c17-bc87-f291c3c3917a",
      name: "New",
      kind: "remote-server",
    });
    const clients = (await db.select().from(schema.oauthClient)).map((row) => row.clientId);
    expect(clients).not.toContain(expired.client_id);
    expect(clients).not.toContain(noGrant.client_id);
    expect(clients).toEqual(
      expect.arrayContaining([live.client_id, claimed.client_id, approved.client_id]),
    );
    expect(
      await db
        .select()
        .from(schema.deviceCode)
        .where(eq(schema.deviceCode.clientId, expired.client_id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.installationRequest)
        .where(eq(schema.installationRequest.id, expired.client_id)),
    ).toEqual([]);
  });
  it("bounds opportunistic cleanup to 25 registrations and keeps the issuance plus grant expiry horizon", async () => {
    const devices = createInstallationStore(db);
    for (let attempt = 0; attempt < 28; attempt++) {
      await devices.register({
        installation_id: "86c897b4-f8fb-4c17-bc87-f291c3c3917a",
        name: "Abandoned",
        kind: "desktop",
      });
    }
    await db
      .update(schema.installationRequest)
      .set({ createdAt: new Date("2000-01-01T00:00:00Z") });
    const [withinHorizon] = await db.select().from(schema.installationRequest).limit(1);
    await db
      .update(schema.installationRequest)
      .set({ createdAt: new Date("2029-12-31T23:41:00Z") })
      .where(eq(schema.installationRequest.id, withinHorizon!.id));
    using _now = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-01-01T00:00:00Z"));
    await devices.register({
      installation_id: "86c897b4-f8fb-4c17-bc87-f291c3c3917a",
      name: "New",
      kind: "desktop",
    });
    expect(await db.select().from(schema.installationRequest)).toHaveLength(4);
    expect(await db.select().from(schema.oauthClient)).toHaveLength(4);
    await devices.register({
      installation_id: "86c897b4-f8fb-4c17-bc87-f291c3c3917a",
      name: "Next",
      kind: "desktop",
    });
    expect(await db.select().from(schema.installationRequest)).toHaveLength(3);
    expect(
      await db
        .select()
        .from(schema.installationRequest)
        .where(eq(schema.installationRequest.id, withinHorizon!.id)),
    ).toHaveLength(1);
  });
  it("rate limits unauthenticated installation registration", async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(
        (
          await authRequest("installation/register", {
            installation_id: "86c897b4-f8fb-4c17-bc87-f291c3c3917a",
            name: "Build host",
            kind: "remote-server",
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await authRequest("installation/register", {
          installation_id: "86c897b4-f8fb-4c17-bc87-f291c3c3917a",
          name: "Build host",
          kind: "remote-server",
        })
      ).status,
    ).toBe(429);
  });
  it("rotates refresh tokens and website revocation blocks the refreshed credential", async () => {
    const cookie = await cloudSignup();
    const grant = await beginInstallation();
    await approveInstallation(grant, cookie);
    const tokens = await (await pollInstallation(grant)).json();
    const refreshed = await authRequest("oauth2/token", {
      client_id: grant.client_id,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json();
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    const details = await (await installationRequest("current", next.access_token)).json();
    const { createInstallationStore } = await import("./installations");
    await createInstallationStore(db).revoke(details.user.id, details.installation.id);
    expect((await installationRequest("current", next.access_token)).status).toBe(401);
  });
});

describe("installation authorization code flow", () => {
  const redirectUri = "https://phoenix.example.test/cloud/callback";
  const verifier = "a".repeat(43);
  async function authorize(cookie: string, callback = redirectUri) {
    const { createHash } = await import("node:crypto");
    const registration = await authRequest("installation/register", {
      installation_id: "86c897b4-f8fb-4c17-bc87-f291c3c3917a",
      name: "Browser machine",
      kind: "remote-server",
      redirect_uri: callback,
    });
    expect(registration.status).toBe(200);
    const client = await registration.json();
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: callback,
      response_type: "code",
      scope: "installation offline_access",
      state: "test-state",
      prompt: "consent",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const response = await authRequest("oauth2/authorize?" + query, undefined, cookie);
    const location = response.headers.get("location") ?? (await response.json()).url;
    expect(location).toContain("/device?");
    return {
      client,
      query,
      oauth_query: new URL(location, "http://localhost:3100").search.slice(1),
      callback,
    };
  }
  async function consent(
    flow: Awaited<ReturnType<typeof authorize>>,
    cookie: string,
    accept = true,
  ) {
    const response = await authRequest(
      "oauth2/consent",
      { oauth_query: flow.oauth_query, accept },
      cookie,
    );
    expect(response.status).toBe(200);
    return new URL((await response.json()).url);
  }
  function exchange(
    flow: Awaited<ReturnType<typeof authorize>>,
    code: string,
    codeVerifier = verifier,
    callback = flow.callback,
  ) {
    return authRequest("oauth2/token", {
      client_id: flow.client.client_id,
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: callback,
    });
  }
  it("requires explicit approval and valid PKCE exchange before assigning ownership, then rejects replay", async () => {
    const cookie = await cloudSignup();
    const flow = await authorize(cookie);
    expect(await db.select().from(schema.installation)).toHaveLength(0);
    const callback = await consent(flow, cookie);
    expect(callback.searchParams.get("state")).toBe("test-state");
    expect(callback.searchParams.get("iss")).toBe("http://localhost:3100/api/auth");
    expect(await db.select().from(schema.installation)).toHaveLength(0);
    const response = await exchange(flow, callback.searchParams.get("code")!);
    expect(response.status).toBe(200);
    const tokens = await response.json();
    expect(tokens.refresh_token).toBeTruthy();
    expect((await installationRequest("current", tokens.access_token)).status).toBe(200);
    expect(
      (await exchange(flow, callback.searchParams.get("code")!)).status,
    ).toBeGreaterThanOrEqual(400);
  });
  it("rejects wrong PKCE without assigning ownership", async () => {
    const cookie = await cloudSignup();
    const flow = await authorize(cookie);
    const callback = await consent(flow, cookie);
    expect(
      (await exchange(flow, callback.searchParams.get("code")!, "b".repeat(43))).status,
    ).toBeGreaterThanOrEqual(400);
    expect(await db.select().from(schema.installation)).toHaveLength(0);
  });
  it("denies approval without creating a code or installation", async () => {
    const cookie = await cloudSignup();
    const flow = await authorize(cookie);
    const callback = await consent(flow, cookie, false);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("code")).toBeNull();
    expect(callback.searchParams.get("iss")).toBe("http://localhost:3100/api/auth");
    expect(await db.select().from(schema.installation)).toHaveLength(0);
  });
  it("binds native loopback to the registered port", async () => {
    const cookie = await cloudSignup();
    const flow = await authorize(cookie, "http://127.0.0.1:49152/cloud/callback");
    const callback = await consent(flow, cookie);
    expect(
      (
        await exchange(
          flow,
          callback.searchParams.get("code")!,
          verifier,
          "http://127.0.0.1:49153/cloud/callback",
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(await db.select().from(schema.installation)).toHaveLength(0);
  });
  it("carries an unauthenticated request through login to explicit consent", async () => {
    const flow = await authorize("");
    expect(
      (await authRequest("oauth2/consent", { oauth_query: flow.oauth_query, accept: true })).status,
    ).toBe(401);
    const cookie = await cloudSignup();
    const callback = await consent(flow, cookie);
    expect((await exchange(flow, callback.searchParams.get("code")!)).status).toBe(200);
  });
  it("rejects changed signed state and expired codes without ownership", async () => {
    const cookie = await cloudSignup();
    const flow = await authorize(cookie);
    const changed = new URLSearchParams(flow.oauth_query);
    changed.set("state", "attacker-state");
    expect(
      (
        await authRequest(
          "oauth2/consent",
          { oauth_query: changed.toString(), accept: true },
          cookie,
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
    const callback = await consent(flow, cookie);
    await db.update(schema.verification).set({ expiresAt: new Date("2000-01-01T00:00:00Z") });
    expect(
      (await exchange(flow, callback.searchParams.get("code")!)).status,
    ).toBeGreaterThanOrEqual(400);
    expect(await db.select().from(schema.installation)).toHaveLength(0);
  });
  it("rejects callback syntax outside the supported fixed destination", async () => {
    for (const callback of [
      "https://phoenix.example.test/other",
      redirectUri + "?next=https://evil.test",
      redirectUri + "#",
      "https://user@phoenix.example.test/cloud/callback",
      "not a url",
      "http://remote.example.test/cloud/callback",
    ]) {
      const response = await authRequest("installation/register", {
        installation_id: "86c897b4-f8fb-4c17-bc87-f291c3c3917a",
        name: "Browser machine",
        kind: "remote-server",
        redirect_uri: callback,
      });
      expect(response.status).toBe(400);
    }
    expect(await db.select().from(schema.oauthClient)).toHaveLength(0);
  });
  it("requires S256 and the exact registered callback at authorization", async () => {
    const cookie = await cloudSignup();
    const flow = await authorize(cookie);
    flow.query.set("code_challenge_method", "plain");
    const plain = await authRequest("oauth2/authorize?" + flow.query, undefined, cookie);
    expect(plain.headers.get("location")).toContain("error=");
    flow.query.set("code_challenge_method", "S256");
    flow.query.set("redirect_uri", "https://evil.test/cloud/callback");
    expect((await authRequest("oauth2/authorize?" + flow.query, undefined, cookie)).status).toBe(
      400,
    );
    expect(await db.select().from(schema.installation)).toHaveLength(0);
  });
  it("supports the explicitly enabled local development callback", async () => {
    vi.stubEnv("PHOENIX_CLOUD_ALLOW_INSECURE_HTTP", "1");
    try {
      const cookie = await cloudSignup();
      const flow = await authorize(cookie, "http://localhost:6157/cloud/callback");
      const callback = await consent(flow, cookie);
      expect((await exchange(flow, callback.searchParams.get("code")!)).status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
