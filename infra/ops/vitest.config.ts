import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The DB-gated suites exercise the launch handler, which requires a
    // Phoenix project id from config. Tests never dispatch to a real Phoenix
    // (they inject a fake client), so any well-formed value works; a real
    // one from the caller's environment still wins.
    env: {
      PHOENIX_PROJECT_ID: process.env.PHOENIX_PROJECT_ID ?? "00000000-0000-4000-8000-000000000e2e",
    },
  },
});
