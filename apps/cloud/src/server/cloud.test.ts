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
  await pg.exec(
    await NodeFSP.readFile(
      new URL("../../drizzle/0000_sparkling_puma.sql", import.meta.url),
      "utf8",
    ),
  );
});
beforeEach(async () => {
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
        "Content-Type": "application/json",
        Origin: "http://localhost:3100",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
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
