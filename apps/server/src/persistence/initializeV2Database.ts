import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { FIRST_V2_MIGRATION_ID } from "./Migrations.ts";

export class V2DatabaseImportError extends Schema.TaggedError<V2DatabaseImportError>()(
  "V2DatabaseImportError",
  { sourcePath: Schema.String, destinationPath: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not copy the V1 database at ${this.sourcePath} to ${this.destinationPath}. The V1 database has not been migrated.`;
  }
}

/**
 * Phoenix V1 builds numbered their own migrations from 55, the ids V2's schema
 * uses. Such a database cannot be migrated by this build, and Phoenix does not
 * import it: V2 starts empty and the V1 file is left for the build that wrote it.
 */
const isPhoenixV1Database = (sourcePath: string) =>
  Effect.try(() => {
    const database = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
    try {
      const ledger = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("effect_sql_migrations");
      if (ledger === undefined) return false;
      const row = database
        .prepare("SELECT MAX(migration_id) AS latest FROM effect_sql_migrations")
        .get() as { latest: number | null } | undefined;
      return (row?.latest ?? 0) >= FIRST_V2_MIGRATION_ID;
    } finally {
      database.close();
    }
  });

/** Its copied legacy tables remain the source for lazy transcript import. */
export const initializeV2Database = Effect.fn("initializeV2Database")(function* (
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(destinationPath);
  const sourcePath = path.join(directory, "state.sqlite");
  yield* Effect.gen(function* () {
    if (yield* fs.exists(destinationPath)) return;
    if (!(yield* fs.exists(sourcePath))) return;
    if (yield* isPhoenixV1Database(sourcePath)) {
      yield* Effect.logWarning(
        "state.sqlite was written by a Phoenix V1 build and is not imported; starting with an empty V2 database",
        { sourcePath },
      );
      return;
    }
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
      directory,
      prefix: ".v2-import-",
    });
    const snapshotPath = path.join(temporaryDirectory, "snapshot.sqlite");
    yield* Effect.tryPromise(async () => {
      const database = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
      try {
        await NodeSqlite.backup(database, snapshotPath);
      } finally {
        database.close();
      }
    });
    // Publish only a complete snapshot, without replacing an existing V2 database.
    yield* fs
      .link(snapshotPath, destinationPath)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
        ),
      );
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) => new V2DatabaseImportError({ sourcePath, destinationPath, cause })),
  );
});
