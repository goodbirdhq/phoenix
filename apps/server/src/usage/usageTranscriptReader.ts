// @effect-diagnostics nodeBuiltinImport:off
/**
 * Raw filesystem access for transcript scanning.
 *
 * Isolated here so the rest of the usage code stays on Effect's `FileSystem`.
 * The direct `node:fs` streaming is deliberate: a cold 30-day window is ~1.4 GB
 * across ~1,500 files, and `readline` over a read stream is roughly an order of
 * magnitude cheaper than materialising each file. The equivalent Effect stream
 * pipeline is idiomatic but not fast enough to sit behind a page load.
 *
 * @module usageTranscriptReader
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";

import type { UsageProviderKind } from "@t3tools/contracts";

import {
  initialCodexScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  parseOpenCodeMessage,
  totalTokens,
  type UsageRecord,
} from "./usageTranscripts.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface OpenCodeDatabaseUsage {
  readonly scannedRows: number;
  readonly malformedRecords: number;
  readonly complete: boolean;
}

const OPEN_CODE_SCAN_BATCH_SIZE = 100;

/**
 * Reads assistant usage from a current OpenCode SQLite store without mutating
 * it. Rows are keyset-paged so every synchronous SQLite call has bounded work,
 * and matching records are emitted immediately so memory does not grow with
 * the requested history window. Exact day/hour filtering remains the
 * aggregator's responsibility.
 */
export async function readOpenCodeUsageDatabase(
  databasePath: string,
  sinceMs: number,
  onRecord: (record: UsageRecord) => void,
): Promise<OpenCodeDatabaseUsage | null> {
  let database: NodeSqlite.DatabaseSync | undefined;
  let scannedRows = 0;
  let malformedRecords = 0;
  try {
    database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    const readBatch = database.prepare(
      `SELECT rowid AS rowId, id, session_id AS sessionId,
              time_created AS timestampMs, data,
              CASE WHEN json_valid(data) THEN json_extract(data, '$.role') END AS role
       FROM message
       WHERE rowid > ?
       ORDER BY rowid
       LIMIT ?`,
    );

    let lastRowId = 0;
    while (true) {
      const rows = readBatch.all(lastRowId, OPEN_CODE_SCAN_BATCH_SIZE) as unknown as ReadonlyArray<{
        readonly rowId: unknown;
        readonly id: unknown;
        readonly sessionId: unknown;
        readonly timestampMs: unknown;
        readonly data: unknown;
        readonly role: unknown;
      }>;
      if (rows.length === 0) break;

      for (const row of rows) {
        scannedRows += 1;
        if (typeof row.rowId !== "number" || !Number.isFinite(row.rowId)) return null;
        lastRowId = Math.trunc(row.rowId);
        if (
          row.role !== "assistant" ||
          typeof row.timestampMs !== "number" ||
          !Number.isFinite(row.timestampMs)
        ) {
          continue;
        }
        const record = parseOpenCodeMessage(row);
        if (record === null) {
          if (row.timestampMs >= sinceMs) malformedRecords += 1;
        } else if (record.timestampMs >= sinceMs && totalTokens(record.totals) > 0) {
          onRecord(record);
        }
      }

      if (rows.length < OPEN_CODE_SCAN_BATCH_SIZE) break;
      // Each SQLite call is bounded by the rowid page above. Yield after every
      // page, including pages with no in-window assistant messages, so excluded
      // history cannot monopolize the WebSocket server event loop.
      await NodeTimersPromises.setImmediate();
    }
    return { scannedRows, malformedRecords, complete: true };
  } catch {
    return scannedRows === 0 ? null : { scannedRows, malformedRecords, complete: false };
  } finally {
    try {
      database?.close();
    } catch {
      // The read result already describes any partial scan; closing a read-only
      // handle cannot invalidate records that were emitted before this point.
    }
  }
}

/**
 * Lists `.jsonl` transcripts under `root` last modified at or after `sinceMs`.
 *
 * Errors on individual entries are swallowed: session files rotate and get
 * removed while the walk is in flight, and a partial listing is far better than
 * failing the page.
 */
export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
): Promise<readonly TranscriptFile[]> {
  const found: TranscriptFile[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      try {
        const stats = await NodeFSP.stat(child);
        if (stats.mtimeMs >= sinceMs) {
          found.push({ path: child, size: stats.size, mtimeMs: stats.mtimeMs });
        }
      } catch {
        // Vanished between readdir and stat.
      }
    }
  };

  await walk(root);
  return found;
}

/**
 * Filesystem identity of a directory, as `device:inode`.
 *
 * Used to tell "two servers reading the same transcript directory" apart from
 * "two machines whose hostname and home path happen to match". Returns an empty
 * string when the directory cannot be stat'd.
 */
export async function readDirectoryVolumeId(path: string): Promise<string> {
  try {
    const stats = await NodeFSP.stat(path);
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return "";
  }
}

/**
 * Streams one transcript and returns the usage records it contains, or `null`
 * when the file could not be read.
 *
 * The distinction matters to the caller's cache: a genuinely empty transcript
 * is a stable fact worth memoising, while a transient read failure memoised
 * under the same `(size, mtime)` key would silently drop that file's usage
 * until the file next changes.
 *
 * Codex carries the active model on `turn_context` lines that hold no usage of
 * their own, so those still have to pass through the reducer to keep model
 * attribution correct.
 */
export async function readTranscriptRecords(
  filePath: string,
  provider: UsageProviderKind,
): Promise<readonly UsageRecord[] | null> {
  const records: UsageRecord[] = [];
  const codexState = initialCodexScanState();

  try {
    const lines = NodeReadline.createInterface({
      input: NodeFS.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (provider === "codex") {
        if (
          !mightCarryUsage(line, provider) &&
          !line.includes('"turn_context"') &&
          !line.includes('"session_meta"')
        ) {
          continue;
        }
        const record = parseCodexLine(line, codexState);
        if (record !== null) records.push(record);
        continue;
      }

      if (!mightCarryUsage(line, provider)) continue;
      const record = parseClaudeLine(line);
      if (record !== null) records.push(record);
    }
  } catch {
    return null;
  }

  return records;
}
