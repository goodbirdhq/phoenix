import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Local dev convenience only: real deployments set these in the process
// environment directly. Silently a no-op when neither file exists.
loadDotenv({ path: [".env.local", ".env"] });

const envSchema = z.object({
  BIRDHOUSE_DATABASE_URL: z.string().min(1, "BIRDHOUSE_DATABASE_URL is required"),
  BIRDHOUSE_HTTP_PORT: z.coerce.number().int().positive().default(3878),
  // Defaulted from BIRDHOUSE_HTTP_PORT below rather than pinned here: this is
  // the callback URL baked into every run's prompt, and a default that
  // ignored an overridden port sent every agent's result to a port birdhouse
  // doesn't own — silently, since the run then just waits out its timeout.
  BIRDHOUSE_PUBLIC_URL: z.url().optional(),
  PHOENIX_BASE_URL: z.url().default("http://127.0.0.1:3873"),
  // Unset until the Phoenix-side integration issues tokens; every call site
  // must treat this as "unauthenticated" rather than assume it is present.
  PHOENIX_BIRDHOUSE_TOKEN: z.string().min(1).optional(),
  BIRDHOUSE_SCHEDULER_TICK_MS: z.coerce.number().int().positive().default(15_000),
  BIRDHOUSE_TIMEZONE: z.string().min(1).default("Europe/London"),
  // Directory scanned for workflow definitions (one subdirectory per
  // workflow, each holding manifest.json + SKILL.md). Relative paths resolve
  // against the package root, not the process cwd.
  BIRDHOUSE_WORKFLOWS_DIR: z.string().min(1).default("workflows"),
  // Phoenix launch parameters. Provider instance/model are not discoverable
  // over HTTP (see docs/phoenix-http-contract.md) and must match the Phoenix
  // settings on this box.
  PHOENIX_PROJECT_ID: z.string().min(1).optional(),
  PHOENIX_PROVIDER_INSTANCE_ID: z.string().min(1).default("claudeAgent"),
  PHOENIX_MODEL: z.string().min(1).default("claude-fable-5"),
  PHOENIX_RUNTIME_MODE: z
    .enum(["approval-required", "auto-accept-edits", "auto", "full-access"])
    .default("auto"),
  BIRDHOUSE_RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(3_600_000),
  BIRDHOUSE_RUN_WATCH_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /** How long finished jobs are kept before the scheduler prunes them. */
  BIRDHOUSE_JOB_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
});

export type OpsConfig = Readonly<
  Omit<z.infer<typeof envSchema>, "BIRDHOUSE_PUBLIC_URL"> & { BIRDHOUSE_PUBLIC_URL: string }
>;

function loadConfig(): OpsConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid birdhouse configuration:\n${issues}`);
  }
  return Object.freeze({
    ...parsed.data,
    BIRDHOUSE_PUBLIC_URL:
      parsed.data.BIRDHOUSE_PUBLIC_URL ?? `http://127.0.0.1:${parsed.data.BIRDHOUSE_HTTP_PORT}`,
  });
}

// Loaded once at import time so misconfiguration fails fast, at process
// startup, rather than on the first query a request happens to trigger.
export const config = loadConfig();
