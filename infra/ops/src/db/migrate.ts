import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, db } from "./client.ts";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder });
  console.log(JSON.stringify({ event: "migrations.applied" }));
}

// Only run when executed directly (`pnpm migrate`); importing this module —
// e.g. from the CLI's `worker` command, which checks migrations before it
// starts draining — must not itself trigger a run.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await runMigrations();
  } finally {
    await closeDb();
  }
}
