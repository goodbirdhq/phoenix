import "@tanstack/react-start/server-only";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  getOAuthProviderApi,
  oauthProvider,
  oauthDeviceAuthorization,
} from "@better-auth/oauth-provider";
import {
  createInstallationStore,
  installationPlugin,
  installationOAuthOptions,
} from "./installations";
import * as schema from "../db/schema";

export function createAuth<T extends PgQueryResultHKT>(
  db: PgDatabase<T, typeof schema>,
  config: { secret: string; baseURL: string },
) {
  return betterAuth({
    ...config,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    plugins: [
      oauthProvider(installationOAuthOptions),
      oauthDeviceAuthorization({
        verificationUri: new URL("/device", config.baseURL).href,
        expiresIn: "10m",
        interval: "5s",
      }),
      installationPlugin(db),
    ],
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        "/installation/register": { window: 60, max: 10 },
        "/device/code": { window: 60, max: 10 },
      },
    },
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (
          ctx.path === "/oauth2/authorize" ||
          (ctx.path === "/oauth2/token" && ctx.body?.grant_type === "authorization_code")
        ) {
          const input = ctx.path === "/oauth2/authorize" ? ctx.query : ctx.body;
          const parsed = z.uuid().safeParse(input?.client_id);
          if (!parsed.success) throw new APIError("BAD_REQUEST", { error: "invalid_client" });
          const [client] = await db
            .select()
            .from(schema.oauthClient)
            .where(eq(schema.oauthClient.clientId, parsed.data));
          const [pending] = await db
            .select()
            .from(schema.installationRequest)
            .where(eq(schema.installationRequest.id, parsed.data));
          if (client && !client.grantTypes?.includes("authorization_code"))
            throw new APIError("BAD_REQUEST", { error: "unauthorized_client" });
          // The native provider permits loopback port substitution; installation attempts do not.
          if (
            !client ||
            client.disabled ||
            !pending ||
            pending.createdAt.getTime() + 600_000 <= Date.now() ||
            !client.grantTypes?.includes("authorization_code") ||
            client.redirectUris.length !== 1 ||
            input?.redirect_uri !== client.redirectUris[0]
          )
            throw new APIError("BAD_REQUEST", {
              error: "invalid_request",
              error_description: "Start a new installation sign-in.",
            });
        }
        if (ctx.path === "/device/code") {
          const parsed = z.uuid().safeParse(ctx.body?.client_id);
          if (!parsed.success)
            throw new APIError("BAD_REQUEST", {
              error: "invalid_client",
              error_description: "Unknown installation client.",
            });
          const clientId = parsed.data;
          const [pending] = await db
            .select()
            .from(schema.installationRequest)
            .where(eq(schema.installationRequest.id, clientId));
          const [existing] = await db
            .select()
            .from(schema.installation)
            .where(eq(schema.installation.id, clientId));
          if (!pending || existing || pending.createdAt.getTime() + 600_000 <= Date.now()) {
            throw new APIError("BAD_REQUEST", {
              error: "invalid_client",
              error_description: "Start a new installation sign-in.",
            });
          }
        }
        if (
          ctx.path === "/oauth2/token" &&
          ctx.body?.grant_type === "urn:ietf:params:oauth:grant-type:device_code"
        ) {
          // A poll can reach us before the approval response hook finishes.
          const [grant] = await db
            .select()
            .from(schema.deviceCode)
            .where(eq(schema.deviceCode.deviceCode, ctx.body.device_code));
          if (
            grant?.status === "approved" &&
            grant.clientId === ctx.body.client_id &&
            grant.expiresAt > new Date()
          ) {
            await createInstallationStore(db).approved(grant.userCode);
          }
        }
        if (ctx.path === "/sign-up/email" && ctx.body?.inviteCode !== "268923") {
          throw new APIError("BAD_REQUEST", { message: "Enter a valid invite code." });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/oauth2/token" && ctx.body?.grant_type === "authorization_code") {
          const returned = z.object({ access_token: z.string() }).safeParse(ctx.context.returned);
          if (returned.success) {
            const payload = await getOAuthProviderApi(
              ctx,
              installationOAuthOptions,
            ).requireActiveAccessToken(returned.data.access_token);
            if (
              typeof payload.client_id !== "string" ||
              !payload.sub ||
              typeof payload.scope !== "string" ||
              !payload.scope.split(" ").includes("installation")
            )
              throw new APIError("UNAUTHORIZED", { message: "Installation credential required." });
            await createInstallationStore(db).exchanged(payload.client_id, payload.sub);
          }
        }
        if (
          ctx.path === "/device/approve" &&
          ctx.context.returned &&
          !(ctx.context.returned instanceof APIError)
        ) {
          const code = String(ctx.body?.userCode ?? "")
            .replace(/[^a-zA-Z0-9]/g, "")
            .toUpperCase();
          await createInstallationStore(db).approved(code);
        }
      }),
    },
  });
}
