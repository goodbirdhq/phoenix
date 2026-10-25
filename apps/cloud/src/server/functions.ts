import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { redirect } from "@tanstack/react-router";
import { renameWorkspaceInput, workspaceId, workspaceInput } from "../lib/validation";

export const currentUser = createServerFn({ method: "GET" }).handler(async () => {
  const { auth } = await import("./auth");
  const session = await auth.api.getSession({ headers: getRequestHeaders() });
  return session
    ? { id: session.user.id, name: session.user.name, email: session.user.email }
    : null;
});

async function ownedStore() {
  const user = await currentUser();
  if (!user) throw redirect({ to: "/login" });
  const [{ db }, { createCloudStore }] = await Promise.all([import("../db"), import("./store")]);
  return { ownerId: user.id, store: createCloudStore(db) };
}

export const listWorkspaces = createServerFn({ method: "GET" }).handler(async () => {
  const { store, ownerId } = await ownedStore();
  return store.listWorkspaces(ownerId);
});
export const createWorkspace = createServerFn({ method: "POST" })
  .validator(workspaceInput)
  .handler(async ({ data }) => {
    const { store, ownerId } = await ownedStore();
    return store.createWorkspace(ownerId, data);
  });
export const renameWorkspace = createServerFn({ method: "POST" })
  .validator(renameWorkspaceInput)
  .handler(async ({ data }) => {
    const { store, ownerId } = await ownedStore();
    return store.renameWorkspace(ownerId, data);
  });
export const deleteWorkspace = createServerFn({ method: "POST" })
  .validator(workspaceId)
  .handler(async ({ data }) => {
    const { store, ownerId } = await ownedStore();
    return store.deleteWorkspace(ownerId, data);
  });
export const listInstallations = createServerFn({ method: "GET" }).handler(async () => {
  const { store, ownerId } = await ownedStore();
  return store.listInstallations(ownerId);
});
export const deleteInstallation = createServerFn({ method: "POST" })
  .validator(workspaceId)
  .handler(async ({ data }) => {
    const { ownerId } = await ownedStore();
    const [{ db }, { createInstallationStore }] = await Promise.all([
      import("../db"),
      import("./installations"),
    ]);
    return createInstallationStore(db).revoke(ownerId, data.id);
  });

export const reviewInstallation = createServerFn({ method: "POST" })
  .validator(
    z
      .string()
      .min(1)
      .max(32)
      .transform((data) =>
        data
          .trim()
          .replace(/[^a-zA-Z0-9]/g, "")
          .toUpperCase(),
      ),
  )
  .handler(async ({ data }) => {
    const [{ db }, { eq }, schema] = await Promise.all([
      import("../db"),
      import("drizzle-orm"),
      import("../db/schema"),
    ]);
    if (!(await currentUser())) throw new Error("Sign in before reviewing this code.");
    const grant = z
      .object({ client_id: z.string().optional(), status: z.string() })
      .parse(await deviceAuthRequest(`/device?user_code=${encodeURIComponent(data)}`));
    if (!grant.client_id || grant.status !== "pending")
      throw new Error("This code is unavailable or already used.");
    const [request] = await db
      .select()
      .from(schema.installationRequest)
      .where(eq(schema.installationRequest.id, grant.client_id));
    if (!request) throw new Error("Installation request not found.");
    return { ...request, userCode: data };
  });
export const decideInstallation = createServerFn({ method: "POST" })
  .validator(z.object({ userCode: z.string().min(1).max(32), approve: z.boolean() }))
  .handler(async ({ data }) => {
    await deviceAuthRequest(data.approve ? "/device/approve" : "/device/deny", {
      userCode: data.userCode,
    });
    return { success: true };
  });

async function deviceAuthRequest(path: string, body?: { userCode: string }) {
  const [{ auth }, { authConfig }] = await Promise.all([import("./auth"), import("./env")]);
  const headers = new Headers(getRequestHeaders());
  headers.set("Content-Type", "application/json");
  // Use the HTTP handler so browser server functions retain Better Auth's rate limits.
  const response = await auth.handler(
    new Request(`${authConfig().baseURL.replace(/\/$/, "")}/api/auth${path}`, {
      method: body ? "POST" : "GET",
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
  if (!response.ok) throw new Error("Device authorization request failed.");
  return response.json();
}
