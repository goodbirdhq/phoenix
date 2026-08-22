// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { readOpenCodeUsageDatabase } from "./usageTranscriptReader.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

describe("readOpenCodeUsageDatabase", () => {
  it("yields while scanning excluded rows before the first matching message", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencode-usage-reader-"));
    temporaryRoots.push(root);
    const databasePath = NodePath.join(root, "opencode.db");
    const database = new NodeSqlite.DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      )
    `);
    const insert = database.prepare(
      "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
    );
    database.exec("BEGIN");
    for (let index = 0; index < 1_000; index += 1) {
      insert.run(
        `old-${index}`,
        "old-session",
        index,
        JSON.stringify({ role: "user", content: "excluded" }),
      );
    }
    insert.run(
      "current-assistant",
      "current-session",
      2_000,
      JSON.stringify({
        role: "assistant",
        time: { completed: 2_001 },
        providerID: "openai",
        modelID: "gpt-5",
        cost: 0.001,
        tokens: { input: 2, output: 1 },
      }),
    );
    insert.run(
      "completed-in-window",
      "boundary-session",
      1_000,
      JSON.stringify({
        role: "assistant",
        time: { completed: 2_002 },
        providerID: "openai",
        modelID: "gpt-5",
        cost: 0.001,
        tokens: { input: 2, output: 1 },
      }),
    );
    database.exec("COMMIT");
    database.close();

    let sentinelRan = false;
    const sentinel = new Promise<void>((resolve) => {
      setImmediate(() => {
        sentinelRan = true;
        resolve();
      });
    });
    const records: UsageRecord[] = [];
    const result = await readOpenCodeUsageDatabase(databasePath, 1_500, (record) => {
      records.push(record);
    });

    expect(sentinelRan).toBe(true);
    expect(result).toEqual({ scannedRows: 1_002, malformedRecords: 0, complete: true });
    expect(records).toHaveLength(2);
    expect(records[0]?.timestampMs).toBe(2_001);
    expect(records[1]?.timestampMs).toBe(2_002);
    await sentinel;
  });
});
