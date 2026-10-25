import * as NodeURL from "node:url";
import { loadEnv } from "vite-plus";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const appRoot = NodeURL.fileURLToPath(new URL("../", import.meta.url));
Object.assign(process.env, loadEnv("development", appRoot, ""));
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL before running cloud migrations.");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  await migrate(drizzle(pool), {
    migrationsFolder: NodeURL.fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  console.log("Phoenix Cloud migrations applied.");
} finally {
  await pool.end();
}
