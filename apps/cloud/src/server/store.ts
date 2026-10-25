import "@tanstack/react-start/server-only";
import { and, desc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "../db/schema";
import {
  installationInput,
  renameWorkspaceInput,
  workspaceId,
  workspaceInput,
} from "../lib/validation";

// The authenticated owner comes from the server session, never from request data.
export function createCloudStore<T extends PgQueryResultHKT>(db: PgDatabase<T, typeof schema>) {
  return {
    listWorkspaces: (ownerId: string) =>
      db
        .select()
        .from(schema.workspace)
        .where(eq(schema.workspace.ownerId, ownerId))
        .orderBy(desc(schema.workspace.createdAt), desc(schema.workspace.id)),
    async createWorkspace(ownerId: string, input: unknown) {
      const { name } = workspaceInput.parse(input);
      const [created] = await db.insert(schema.workspace).values({ ownerId, name }).returning();
      return created!;
    },
    async renameWorkspace(ownerId: string, input: unknown) {
      const { id, name } = renameWorkspaceInput.parse(input);
      const [renamed] = await db
        .update(schema.workspace)
        .set({ name, updatedAt: new Date() })
        .where(and(eq(schema.workspace.id, id), eq(schema.workspace.ownerId, ownerId)))
        .returning();
      if (!renamed) throw new Error("Workspace not found.");
      return renamed;
    },
    async deleteWorkspace(ownerId: string, input: unknown) {
      const { id } = workspaceId.parse(input);
      const deleted = await db
        .delete(schema.workspace)
        .where(and(eq(schema.workspace.id, id), eq(schema.workspace.ownerId, ownerId)))
        .returning({ id: schema.workspace.id });
      if (!deleted.length) throw new Error("Workspace not found.");
      return { id };
    },
    listInstallations: (ownerId: string) =>
      db
        .select()
        .from(schema.installation)
        .where(eq(schema.installation.ownerId, ownerId))
        .orderBy(desc(schema.installation.createdAt), desc(schema.installation.id)),
    async registerInstallation(ownerId: string, input: unknown) {
      const { name, kind } = installationInput.parse(input);
      const [created] = await db
        .insert(schema.installation)
        .values({ ownerId, name, kind })
        .returning();
      return created!;
    },
    async deleteInstallation(ownerId: string, input: unknown) {
      const { id } = workspaceId.parse(input);
      const deleted = await db
        .delete(schema.installation)
        .where(and(eq(schema.installation.id, id), eq(schema.installation.ownerId, ownerId)))
        .returning({ id: schema.installation.id });
      if (!deleted.length) throw new Error("Device registration not found.");
      return { id };
    },
  };
}
