import "@tanstack/react-start/server-only";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { databaseUrl } from "../server/env";

export const pool = new Pool({ connectionString: databaseUrl(), max: 10 });
export const db = drizzle(pool, { schema });
