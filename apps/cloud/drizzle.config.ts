import { defineConfig } from "drizzle-kit";
import { loadEnv } from "vite-plus";

Object.assign(process.env, loadEnv("development", process.cwd(), ""));
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL to generate cloud migrations.");
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL },
});
