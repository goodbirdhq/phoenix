import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Local dev convenience only: real deployments set these in the process
// environment directly. Silently a no-op when neither file exists.
loadDotenv({ path: [".env.local", ".env"] });

const envSchema = z.object({
  OPS_DATABASE_URL: z.string().min(1, "OPS_DATABASE_URL is required"),
  OPS_HTTP_PORT: z.coerce.number().int().positive().default(3878),
  OPS_PUBLIC_URL: z.url().default("http://127.0.0.1:3878"),
  PHOENIX_BASE_URL: z.url().default("http://127.0.0.1:3873"),
  // Unset until the Phoenix-side integration issues tokens; every call site
  // must treat this as "unauthenticated" rather than assume it is present.
  PHOENIX_OPS_TOKEN: z.string().min(1).optional(),
  OPS_SCHEDULER_TICK_MS: z.coerce.number().int().positive().default(15_000),
  OPS_TIMEZONE: z.string().min(1).default("Europe/London"),
  // Directory scanned for workflow definitions (one subdirectory per
  // workflow, each holding manifest.json + SKILL.md). Relative paths resolve
  // against the package root, not the process cwd.
  OPS_WORKFLOWS_DIR: z.string().min(1).default("workflows"),
  // Phoenix launch parameters. Provider instance/model are not discoverable
  // over HTTP (see docs/phoenix-http-contract.md) and must match the Phoenix
  // settings on this box.
  PHOENIX_PROJECT_ID: z.string().min(1).optional(),
  PHOENIX_PROVIDER_INSTANCE_ID: z.string().min(1).default("claudeAgent"),
  PHOENIX_MODEL: z.string().min(1).default("claude-fable-5"),
  PHOENIX_RUNTIME_MODE: z
    .enum(["approval-required", "auto-accept-edits", "auto", "full-access"])
    .default("auto"),
  OPS_RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(3_600_000),
  OPS_RUN_WATCH_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
});

export type OpsConfig = Readonly<z.infer<typeof envSchema>>;

function loadConfig(): OpsConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid ops hub configuration:\n${issues}`);
  }
  return Object.freeze(parsed.data);
}

// Loaded once at import time so misconfiguration fails fast, at process
// startup, rather than on the first query a request happens to trigger.
export const config = loadConfig();
