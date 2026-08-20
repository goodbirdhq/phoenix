import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationLedgerMismatchError, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const cleanLayer = it.layer(NodeSqliteClient.layerMemory());
const renamedLayer = it.layer(NodeSqliteClient.layerMemory());
const gapLayer = it.layer(NodeSqliteClient.layerMemory());
const rollbackLayer = it.layer(NodeSqliteClient.layerMemory());

cleanLayer("migration ledger guard", (it) => {
  it.effect("stays out of the way when the ledger matches the manifest", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 10 });
      // Re-running against a ledger this build wrote itself must not trip.
      const executed = yield* runMigrations({ toMigrationInclusive: 10 });
      assert.deepStrictEqual(executed, []);
    }),
  );
});

renamedLayer("migration ledger guard", (it) => {
  it.effect("refuses to start when a recorded id was renumbered", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 10 });
      const sql = yield* SqlClient.SqlClient;
      // Mimics a branch build that numbered migration 5 differently.
      yield* sql`UPDATE effect_sql_migrations SET name = 'SomethingElse' WHERE migration_id = 5`;

      const error = yield* Effect.flip(runMigrations({ toMigrationInclusive: 10 }));
      assert.instanceOf(error, MigrationLedgerMismatchError);
      assert.lengthOf(error.divergences, 1);
      assert.include(error.divergences[0]!, '5 is recorded as "SomethingElse"');
      assert.include(error.message, "Reconcile effect_sql_migrations");
    }),
  );
});

gapLayer("migration ledger guard", (it) => {
  it.effect("refuses to start when a migration below the high-water mark never ran", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 10 });
      const sql = yield* SqlClient.SqlClient;
      // The exact shape of the 2026-08-20 incident: an id inserted upstream
      // below the mark, so the migrator would skip it forever.
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 4`;

      const error = yield* Effect.flip(runMigrations({ toMigrationInclusive: 10 }));
      assert.instanceOf(error, MigrationLedgerMismatchError);
      assert.lengthOf(error.divergences, 1);
      assert.include(error.divergences[0]!, "would never run");
    }),
  );
});

rollbackLayer("migration ledger guard", (it) => {
  it.effect("allows a ledger recorded ahead of this build, so rollbacks still boot", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 10 });
      // Running an older build against a newer database is a valid rollback.
      const executed = yield* runMigrations({ toMigrationInclusive: 6 });
      assert.deepStrictEqual(executed, []);
    }),
  );
});
