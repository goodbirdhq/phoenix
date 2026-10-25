import "@tanstack/react-start/server-only";
import * as NodeCrypto from "node:crypto";
import { sql, and, eq, isNull, isNotNull, notExists, or, gte, lt, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { APIError, createAuthEndpoint } from "better-auth/api";
import {
  DEVICE_CODE_GRANT_TYPE,
  getOAuthProviderApi,
  type OAuthOptions,
} from "@better-auth/oauth-provider";
import { z } from "zod";
import * as schema from "../db/schema";
import { installationInput } from "../lib/validation";

export const installationOAuthOptions = {
  loginPage: "/login",
  consentPage: "/device",
  // Tokens stay inside this Cloud app; its resource boundary checks active client, owner and scope.
  disableJwtPlugin: true,
  scopes: ["installation", "offline_access"],
  // The provider requires authorization_code globally for refresh; installation clients permit only device and refresh grants.
  grantTypes: ["authorization_code", DEVICE_CODE_GRANT_TYPE, "refresh_token"],
  accessTokenExpiresIn: 3600,
  refreshTokenExpiresIn: 2592000,
  allowDynamicClientRegistration: false,
  allowUnauthenticatedClientRegistration: false,
  clientPrivileges: async () => false,
} satisfies OAuthOptions<string[]>;

export function createInstallationStore<T extends PgQueryResultHKT>(
  db: PgDatabase<T, typeof schema>,
) {
  return {
    async register(input: unknown) {
      const data = installationInput.extend({ installation_id: z.uuid() }).parse(input);
      const id = NodeCrypto.randomUUID();
      await db.transaction(async (tx) => {
        const now = new Date();
        // Registration can issue a grant for ten minutes; that grant lives another ten.
        // Never purge claimed requests or anything that could still authorize a machine.
        const abandoned = await tx
          .select({ id: schema.installationRequest.id })
          .from(schema.installationRequest)
          .where(
            and(
              lt(schema.installationRequest.createdAt, new Date(Date.now() - 20 * 60_000)),
              notExists(
                tx
                  .select()
                  .from(schema.installation)
                  .where(eq(schema.installation.id, schema.installationRequest.id)),
              ),
              notExists(
                tx
                  .select()
                  .from(schema.deviceCode)
                  .where(
                    and(
                      eq(schema.deviceCode.clientId, sql`${schema.installationRequest.id}::text`),
                      or(
                        isNotNull(schema.deviceCode.userId),
                        gte(schema.deviceCode.expiresAt, now),
                      ),
                    ),
                  ),
              ),
              notExists(
                tx
                  .select()
                  .from(schema.oauthAccessToken)
                  .where(
                    eq(
                      schema.oauthAccessToken.clientId,
                      sql`${schema.installationRequest.id}::text`,
                    ),
                  ),
              ),
              notExists(
                tx
                  .select()
                  .from(schema.oauthRefreshToken)
                  .where(
                    eq(
                      schema.oauthRefreshToken.clientId,
                      sql`${schema.installationRequest.id}::text`,
                    ),
                  ),
              ),
              notExists(
                tx
                  .select()
                  .from(schema.oauthConsent)
                  .where(
                    eq(schema.oauthConsent.clientId, sql`${schema.installationRequest.id}::text`),
                  ),
              ),
            ),
          )
          .orderBy(schema.installationRequest.createdAt, schema.installationRequest.id)
          .limit(25);
        if (abandoned.length) {
          const ids = abandoned.map((row) => row.id);
          await tx.delete(schema.deviceCode).where(inArray(schema.deviceCode.clientId, ids));
          await tx
            .delete(schema.installationRequest)
            .where(inArray(schema.installationRequest.id, ids));
          await tx.delete(schema.oauthClient).where(inArray(schema.oauthClient.clientId, ids));
        }
        // One OAuth client per attempt makes authorization and revocation installation-specific.
        await tx.insert(schema.oauthClient).values({
          id,
          clientId: id,
          name: data.name,
          disabled: false,
          redirectUris: [],
          scopes: ["installation", "offline_access"],
          grantTypes: [DEVICE_CODE_GRANT_TYPE, "refresh_token"],
          tokenEndpointAuthMethod: "none",
          applicationType: "native",
          createdAt: new Date(),
        });
        await tx.insert(schema.installationRequest).values({
          id,
          installationId: data.installation_id,
          name: data.name,
          kind: data.kind,
        });
      });
      return { client_id: id, installation_id: id };
    },
    async approved(userCode: string) {
      const [grant] = await db
        .select()
        .from(schema.deviceCode)
        .where(eq(schema.deviceCode.userCode, userCode));
      if (!grant || grant.status !== "approved" || !grant.userId || !grant.clientId) return;
      const [request] = await db
        .select()
        .from(schema.installationRequest)
        .where(eq(schema.installationRequest.id, grant.clientId));
      if (!request)
        throw new APIError("BAD_REQUEST", { message: "Installation request not found." });
      await db
        .insert(schema.installation)
        .values({
          id: request.id,
          installationId: request.installationId,
          ownerId: grant.userId,
          kind: request.kind,
          name: request.name,
        })
        .onConflictDoNothing();
    },
    async details(id: string, ownerId: string, heartbeat = false) {
      if (heartbeat)
        await db
          .update(schema.installation)
          .set({ lastSeenAt: new Date() })
          .where(
            and(
              eq(schema.installation.id, id),
              eq(schema.installation.ownerId, ownerId),
              isNull(schema.installation.revokedAt),
            ),
          );
      const [row] = await db
        .select()
        .from(schema.installation)
        .where(
          and(
            eq(schema.installation.id, id),
            eq(schema.installation.ownerId, ownerId),
            isNull(schema.installation.revokedAt),
          ),
        );
      const [owner] = await db
        .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
        .from(schema.user)
        .where(eq(schema.user.id, ownerId));
      if (!row || !owner)
        throw new APIError("UNAUTHORIZED", { message: "Installation disconnected." });
      return {
        installation: {
          id: row.id,
          installationId: row.installationId,
          name: row.name,
          kind: row.kind,
          lastSeenAt: row.lastSeenAt,
        },
        user: owner,
      };
    },
    async revoke(ownerId: string, id: string) {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .update(schema.installation)
          .set({ revokedAt: new Date() })
          .where(and(eq(schema.installation.id, id), eq(schema.installation.ownerId, ownerId)))
          .returning();
        if (!row) throw new APIError("NOT_FOUND", { message: "Device not found." });
        await tx
          .update(schema.oauthClient)
          .set({ disabled: true })
          .where(eq(schema.oauthClient.clientId, id));
        await tx
          .update(schema.oauthAccessToken)
          .set({ revoked: new Date() })
          .where(eq(schema.oauthAccessToken.clientId, id));
        await tx
          .update(schema.oauthRefreshToken)
          .set({ revoked: new Date() })
          .where(eq(schema.oauthRefreshToken.clientId, id));
      });
      return { id };
    },
  };
}

export function installationPlugin<T extends PgQueryResultHKT>(db: PgDatabase<T, typeof schema>) {
  const store = createInstallationStore(db);
  const endpoint = (
    path: string,
    method: "GET" | "POST",
    action: "current" | "heartbeat" | "disconnect",
  ) =>
    createAuthEndpoint(path, { method }, async (ctx) => {
      const token = ctx.headers?.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
      if (!token)
        throw new APIError("UNAUTHORIZED", { message: "Installation credential required." });
      const payload = await getOAuthProviderApi(
        ctx,
        installationOAuthOptions,
      ).requireActiveAccessToken(token);
      if (
        typeof payload.scope !== "string" ||
        !payload.scope.split(" ").includes("installation") ||
        typeof payload.client_id !== "string" ||
        !payload.sub
      )
        throw new APIError("UNAUTHORIZED", { message: "Installation credential required." });
      const details = await store.details(payload.client_id, payload.sub, action === "heartbeat");
      if (action === "disconnect") {
        await store.revoke(payload.sub, payload.client_id);
        return new Response(null, { status: 204 });
      }
      ctx.setHeader("Cache-Control", "no-store");
      return ctx.json(details);
    });
  return {
    id: "cloud-installations",
    endpoints: {
      registerCloudInstallation: createAuthEndpoint(
        "/installation/register",
        {
          method: "POST",
          body: installationInput.extend({ installation_id: z.uuid() }),
        },
        async (ctx) => ctx.json(await store.register(ctx.body)),
      ),
      currentCloudInstallation: endpoint("/installation/current", "GET", "current"),
      heartbeatCloudInstallation: endpoint("/installation/heartbeat", "POST", "heartbeat"),
      disconnectCloudInstallation: endpoint("/installation/disconnect", "POST", "disconnect"),
    },
  };
}
