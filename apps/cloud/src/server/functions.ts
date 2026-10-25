import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { redirect } from "@tanstack/react-router";
import {
  installationInput,
  renameWorkspaceInput,
  workspaceId,
  workspaceInput,
} from "../lib/validation";

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
export const registerInstallation = createServerFn({ method: "POST" })
  .validator(installationInput)
  .handler(async ({ data }) => {
    const { store, ownerId } = await ownedStore();
    return store.registerInstallation(ownerId, data);
  });
export const deleteInstallation = createServerFn({ method: "POST" })
  .validator(workspaceId)
  .handler(async ({ data }) => {
    const { store, ownerId } = await ownedStore();
    return store.deleteInstallation(ownerId, data);
  });
