import { defineConfig } from "drizzle-kit";
import { loadEnv } from "vite-plus";
import * as NodeURL from "node:url";

const appRoot = NodeURL.fileURLToPath(new URL("./", import.meta.url));
const env = loadEnv("development", appRoot, "");
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  ...(env.DATABASE_URL ? { dbCredentials: { url: env.DATABASE_URL } } : {}),
});
