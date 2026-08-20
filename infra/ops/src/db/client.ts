import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { config } from "../config.ts";

export const pool = new Pool({ connectionString: config.OPS_DATABASE_URL });

// No `schema` option: this package only uses the query builder
// (`db.select()`/`.insert()`/...) against table objects imported directly
// from `./schema.ts`, never the `db.query.*` relational API that `schema`
// exists to wire up.
export const db = drizzle({ client: pool });

export type Db = typeof db;
/** A transaction handle from `db.transaction`. */
export type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything that can run queries: the pooled db or an open transaction. */
export type DbOrTx = Db | Transaction;

export async function closeDb(): Promise<void> {
  await pool.end();
}
