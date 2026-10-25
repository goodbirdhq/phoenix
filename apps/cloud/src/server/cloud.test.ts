import * as NodeFSP from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
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
    await approveInstallation(grant, owner);
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
