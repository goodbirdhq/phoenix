import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The DB-gated suites exercise the launch handler, which requires a
    // Phoenix project id from config. Tests never dispatch to a real Phoenix
    // (they inject a fake client), so any well-formed value works; a real
    // one from the caller's environment still wins.
    env: {
      PHOENIX_PROJECT_ID: process.env.PHOENIX_PROJECT_ID ?? "00000000-0000-4000-8000-000000000e2e",
      // config.ts validates at import time so a misconfigured process fails
      // at startup rather than mid-request. That also means any test file
      // importing a module that reaches config.ts fails to load without a
      // database URL — before `describe.skipIf` gets to skip anything — so a
      // machine with no Postgres can't even collect the suite. This
      // placeholder satisfies that import; the suites that genuinely need a
      // database are gated on BIRDHOUSE_TEST_DATABASE_URL and open their own
      // pool from it, and a real value from the caller still wins.
      BIRDHOUSE_DATABASE_URL:
        process.env.BIRDHOUSE_DATABASE_URL ??
        process.env.BIRDHOUSE_TEST_DATABASE_URL ??
        "postgresql://birdhouse:birdhouse@127.0.0.1:5432/birdhouse_no_database_configured",
    },
  },
});
