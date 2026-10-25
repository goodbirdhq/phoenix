import "@tanstack/react-start/server-only";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import * as schema from "../db/schema";

export function createAuth(
  db: Parameters<typeof drizzleAdapter>[0],
  config: { secret: string; baseURL: string },
) {
  return betterAuth({
    ...config,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true, minPasswordLength: 12 },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-up/email" && ctx.body?.inviteCode !== "268923") {
          throw new APIError("BAD_REQUEST", { message: "Enter a valid invite code." });
        }
      }),
    },
  });
}
