/**
 * ClaudeUsageProbe - bounded, read-only Claude Code `/usage` collection.
 *
 * Claude does not expose the rendered subscription bars through the Agent SDK,
 * so the CLI's own `/usage` command is the narrowest honest source. It is run
 * non-interactively (`claude --print /usage --output-format json`), which the
 * CLI answers locally: the returned envelope reports `num_turns: 0` and
 * `total_cost_usd: 0`, so reading quota never becomes an agent turn. Print mode
 * also skips the interactive workspace-trust dialog, so the probe never answers
 * a consent prompt on the user's behalf.
 *
 * Collection is explicit and on-demand: it is never a provider health check.
 *
 * @module provider/Drivers/ClaudeUsageProbe
 */
// @effect-diagnostics globalDate:off
/* eslint-disable no-control-regex -- stripping stray CLI control sequences is this boundary's job. */
import type {
  ProviderAvailability,
  ProviderAvailabilityAccount,
  ProviderAvailabilityWindow,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";

import { spawnAndCollect } from "../providerSnapshot.ts";

/** Budget for one CLI invocation. `/usage` normally answers in ~2s. */
const CLAUDE_USAGE_PROBE_TIMEOUT_MS = 20_000;
const CLAUDE_AUTH_STATUS_TIMEOUT_MS = 10_000;
/** The rendered panel is ~2 KB; anything larger is not a panel we understand. */
const MAX_OUTPUT_CHARS = 64_000;
/**
 * Hard cap on what is retained from the child's pipes, applied while reading
 * rather than after. A timeout alone does not bound memory: a CLI that streams
 * megabytes a second would be fully buffered before the deadline fires. The
 * cap is generous relative to `MAX_OUTPUT_CHARS` so that oversized-but-honest
 * output is still recognised as oversized instead of read as malformed JSON.
 */
export const CLAUDE_USAGE_MAX_OUTPUT_BYTES = 4 * MAX_OUTPUT_CHARS;

const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

/**
 * Removes formatting the CLI may still emit when a host forces colour, and
 * keeps only the last write of a redrawn line. A carriage return without a
 * line feed rewrites the current line, so the surviving text is the final
 * frame of that line — never a mixture of a stale percentage and a fresh
 * heading.
 */
export const stripTerminalFormatting = (value: string): string =>
  value
    .replace(ANSI_ESCAPE, "")
    .replace(/\u0007/g, "")
    .split("\n")
    .map((line) => {
      const frames = line.split("\r");
      return (frames[frames.length - 1] ?? "").replace(/[\u0000-\u0008\u000B-\u001F]/g, "");
    })
    .join("\n");

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

/**
 * Offset of `timeZone` from UTC at `instant`, or undefined when the zone is
 * not one this runtime knows. Reading the parts back out of `Intl` is the only
 * way to resolve a wall-clock reading (`Aug 18, 9pm (Europe/Berlin)`) without
 * shipping a timezone table.
 */
const timeZoneOffsetMs = (timeZone: string, instant: Date): number | undefined => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(instant);
    const read = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
    const asUtc = Date.UTC(
      read("year"),
      read("month") - 1,
      read("day"),
      read("hour"),
      read("minute"),
      read("second"),
    );
    return Number.isFinite(asUtc) ? asUtc - instant.getTime() : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Wall-clock reading in `timeZone` (or the host zone when the CLI omits one)
 * as an instant. The offset is resolved twice so a reading that lands on a DST
 * transition settles on the offset actually in force at the result.
 */
const instantFromWallClock = (
  wall: {
    readonly year: number;
    readonly monthIndex: number;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
  },
  timeZone: string | undefined,
): Date | undefined => {
  if (timeZone === undefined) {
    const local = new Date(wall.year, wall.monthIndex, wall.day, wall.hour, wall.minute, 0, 0);
    return Number.isNaN(local.getTime()) ? undefined : local;
  }
  const utcGuess = Date.UTC(wall.year, wall.monthIndex, wall.day, wall.hour, wall.minute);
  const firstOffset = timeZoneOffsetMs(timeZone, new Date(utcGuess));
  if (firstOffset === undefined) return undefined;
  const firstGuess = new Date(utcGuess - firstOffset);
  const secondOffset = timeZoneOffsetMs(timeZone, firstGuess) ?? firstOffset;
  return new Date(utcGuess - secondOffset);
};

/**
 * `Aug 18, 9pm (Europe/Berlin)` / `Aug 18, 12:59am (Europe/Berlin)`. The CLI
 * omits the year, so the first reading at or after the observation wins.
 */
const absoluteReset = (value: string, observedAt: Date): string | undefined => {
  const match = value.match(
    /\b([A-Za-z]{3,9})\s+(\d{1,2}),?\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b\s*(?:\(([^)]+)\))?/i,
  );
  if (!match) return undefined;
  const monthIndex = MONTHS.indexOf(
    (match[1] ?? "").slice(0, 3).toLowerCase() as (typeof MONTHS)[number],
  );
  const day = Number(match[2]);
  if (monthIndex < 0 || !Number.isInteger(day) || day < 1 || day > 31) return undefined;
  const rawHour = Number(match[3]);
  if (!Number.isInteger(rawHour) || rawHour < 1 || rawHour > 12) return undefined;
  const minute = match[4] === undefined ? 0 : Number(match[4]);
  if (!Number.isInteger(minute) || minute > 59) return undefined;
  const meridiem = (match[5] ?? "").toLowerCase();
  const hour = meridiem === "pm" ? (rawHour % 12) + 12 : rawHour % 12;
  const timeZone = match[6]?.trim();

  const observedYear = observedAt.getFullYear();
  for (const year of [observedYear, observedYear + 1]) {
    const instant = instantFromWallClock({ year, monthIndex, day, hour, minute }, timeZone);
    if (!instant || Number.isNaN(instant.getTime())) continue;
    // A rendered reset is always ahead of the reading; only a year boundary can
    // make the same wall clock look like the past.
    if (instant.getTime() >= observedAt.getTime()) return instant.toISOString();
  }
  return undefined;
};

/** `in 4h 52m` / `in 3 hours` — the relative wording older CLIs render. */
const relativeReset = (value: string, observedAt: Date): string | undefined => {
  const match = value.match(
    /\bin\s+(?:(\d{1,3})\s*(?:h|hr|hrs|hour|hours)\b)?\s*(?:(\d{1,3})\s*(?:m|min|mins|minute|minutes)\b)?/i,
  );
  if (!match || (match[1] === undefined && match[2] === undefined)) return undefined;
  const minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
  return new Date(observedAt.getTime() + minutes * 60_000).toISOString();
};

/** Reset wording from one rendered row. Unknown wording yields no timestamp. */
export const parseClaudeUsageReset = (value: string, observedAt: Date): string | undefined =>
  absoluteReset(value, observedAt) ?? relativeReset(value, observedAt);

type UsageWindowIdentity = Pick<ProviderAvailabilityWindow, "kind" | "label" | "scope">;

/** The pool every model draws from, however the panel words that row. */
const ALL_MODELS_WEEKLY_SCOPE = "all-models";

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * The rendered row label → a provider-native window identity. Only labels the
 * CLI actually renders as quota rows are mapped; anything else is skipped so a
 * prose line can never become a window.
 */
const windowIdentity = (label: string): UsageWindowIdentity | undefined => {
  const normalized = label.trim().replace(/\s+/g, " ");
  if (/^current session$/i.test(normalized)) {
    return { kind: "session", label: "Current session" };
  }
  // A panel may render the pooled weekly row either way, and both name the same
  // pool. Every weekly identity carries an explicit scope so the shared pool can
  // never collide with a per-model pool in the dedupe key or in a client's
  // render key — a collision would silently drop a real quota row.
  if (/^current week$/i.test(normalized)) {
    return { kind: "weekly", label: "Current week", scope: ALL_MODELS_WEEKLY_SCOPE };
  }
  const weekly = normalized.match(/^current week\s*\(([^)]+)\)$/i);
  if (!weekly) return undefined;
  const pool = (weekly[1] ?? "").trim();
  if (pool.length === 0) return undefined;
  if (/^all models$/i.test(pool)) {
    return { kind: "weekly", label: "All models", scope: ALL_MODELS_WEEKLY_SCOPE };
  }
  const scope = slugify(pool);
  return scope.length > 0 ? { kind: "model-weekly", label: pool, scope } : undefined;
};

// One rendered quota row: `Current week (all models): 77% used · resets ...`.
// The percentage and its reset must come from this row; nothing is borrowed
// from a neighbouring line. The CLI renders whole percents today and a fraction
// (`0.5% used`, and `0,5% used` in a comma-decimal locale) is still a reading,
// so the row shape accepts one rather than skipping the row entirely.
const USAGE_ROW = /^\s*([^:]{1,80}):\s*(\d{1,3}(?:[.,]\d{1,4})?)\s*%\s+used\b(.*)$/i;

/**
 * A rendered percentage as a number in 0–100, or undefined when the row does
 * not carry one. Fractions are kept to a tenth: that is the finest reading a
 * panel plausibly renders, and it keeps a client from printing a float artefact
 * such as `12.299999999999999% used`.
 */
export const parseUsedPercent = (value: string): number | undefined => {
  const parsed = Number(value.trim().replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return undefined;
  return Math.round(parsed * 10) / 10;
};

/**
 * Windows rendered by one `/usage` panel, in panel order and deduplicated by
 * identity. A row Phoenix cannot name is dropped rather than guessed.
 */
const parseClaudeUsageWindows = (
  panel: string,
  observedAt: Date,
): ReadonlyArray<ProviderAvailabilityWindow> => {
  const windows: ProviderAvailabilityWindow[] = [];
  const seen = new Set<string>();
  for (const line of stripTerminalFormatting(panel).split("\n")) {
    const row = line.match(USAGE_ROW);
    if (!row) continue;
    const identity = windowIdentity(row[1] ?? "");
    if (!identity) continue;
    const usedPercent = parseUsedPercent(row[2] ?? "");
    if (usedPercent === undefined) continue;
    const key = `${identity.kind}:${identity.scope ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const resetsAt = parseClaudeUsageReset(row[3] ?? "", observedAt);
    windows.push({
      ...identity,
      usedPercent,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows;
};

/** Parse the CLI's rendered `/usage` panel without deriving quota from tokens. */
export const parseClaudeUsagePanel = (
  panel: string,
  observedAt: Date,
  account?: ProviderAvailabilityAccount,
): ProviderAvailability => {
  const windows = parseClaudeUsageWindows(panel, observedAt);
  return {
    status: windows.some((window) => window.usedPercent >= 100)
      ? "limited"
      : windows.length > 0
        ? "available"
        : "unknown",
    source: "claude_cli_usage",
    observedAt: observedAt.toISOString(),
    ...(account ? { account } : {}),
    windows,
  };
};

/** An availability snapshot that reports "we did not learn anything". */
export const unknownClaudeUsage = (
  observedAt: Date,
  account?: ProviderAvailabilityAccount,
): ProviderAvailability => ({
  status: "unknown",
  source: "claude_cli_usage",
  observedAt: observedAt.toISOString(),
  ...(account ? { account } : {}),
  windows: [],
});

export type ClaudeUsageEnvelope =
  | { readonly _tag: "panel"; readonly text: string }
  | { readonly _tag: "rejected"; readonly reason: string };

const decodeUnknownJsonStringExit = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const readJsonRecord = (value: string): Record<string, unknown> | undefined => {
  const decoded = decodeUnknownJsonStringExit(value);
  if (!Exit.isSuccess(decoded)) return undefined;
  const parsed = decoded.value;
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
};

/**
 * True only for a JSON number that is exactly zero. A missing counter, a
 * stringified one, `NaN`, and an infinity are all "the CLI did not tell us this
 * was free", which is the case this guard exists to catch.
 */
const isReportedZero = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value) && value === 0;

/**
 * The `--output-format json` envelope around the panel. The turn and cost
 * counters are required rather than trusted: the whole claim that reading quota
 * is free rests on the CLI answering `/usage` locally, so the panel is only
 * accepted when the envelope positively reports `num_turns: 0` *and*
 * `total_cost_usd: 0`. A CLI version that stops reporting either one reads as
 * unknown instead of being presented as free quota data.
 */
export const readClaudeUsageEnvelope = (stdout: string): ClaudeUsageEnvelope => {
  if (stdout.length > MAX_OUTPUT_CHARS) {
    return { _tag: "rejected", reason: "usage output exceeded the expected size" };
  }
  const envelope = readJsonRecord(stdout.trim());
  if (!envelope) {
    return { _tag: "rejected", reason: "usage output was not a JSON envelope" };
  }
  if (envelope.is_error === true) {
    return { _tag: "rejected", reason: "CLI reported an error for /usage" };
  }
  if (!isReportedZero(envelope.num_turns)) {
    return { _tag: "rejected", reason: "CLI did not report /usage as a zero-turn read" };
  }
  if (!isReportedZero(envelope.total_cost_usd)) {
    return { _tag: "rejected", reason: "CLI did not report /usage as a zero-cost read" };
  }
  const text = envelope.result;
  if (typeof text !== "string" || text.trim().length === 0) {
    return { _tag: "rejected", reason: "usage envelope carried no rendered panel" };
  }
  return { _tag: "panel", text };
};

export interface ClaudeAuthStatus {
  readonly loggedIn: boolean;
  readonly email: string | undefined;
  readonly orgId: string | undefined;
  readonly apiProvider: string | undefined;
  readonly subscriptionType: string | undefined;
}

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

/** `claude auth status --json`. Anything unparseable reads as "not known". */
export const parseClaudeAuthStatus = (stdout: string): ClaudeAuthStatus | undefined => {
  if (stdout.length > MAX_OUTPUT_CHARS) return undefined;
  const status = readJsonRecord(stripTerminalFormatting(stdout).trim());
  if (!status || typeof status.loggedIn !== "boolean") return undefined;
  return {
    loggedIn: status.loggedIn,
    email: readString(status.email),
    orgId: readString(status.orgId),
    apiProvider: readString(status.apiProvider),
    subscriptionType: readString(status.subscriptionType),
  };
};

/**
 * The account subject Phoenix is allowed to publish. It exists only when the
 * CLI itself reports a signed-in first-party account, and it is scoped by the
 * reported organisation so two accounts in different orgs never collapse into
 * one card.
 */
export const claudeUsageAccount = (
  status: ClaudeAuthStatus | undefined,
): ProviderAvailabilityAccount | undefined => {
  if (!status?.loggedIn || status.email === undefined) return undefined;
  if (status.apiProvider !== undefined && status.apiProvider !== "firstParty") return undefined;
  return {
    id: `claude:${status.orgId ?? "no-org"}:${status.email.toLowerCase()}`,
    verification: "native_verified",
    displayName: status.email,
  };
};

/**
 * Subscription quota is a first-party Anthropic concept. Bedrock/Vertex/Foundry
 * instances bill through the cloud account instead, so they are not probed.
 */
const isSubscriptionCapableAuth = (status: ClaudeAuthStatus): boolean =>
  status.loggedIn && (status.apiProvider === undefined || status.apiProvider === "firstParty");

/**
 * One bounded CLI call, bounded in both directions: the collector stops
 * retaining output at `CLAUDE_USAGE_MAX_OUTPUT_BYTES`, and timing out closes
 * the scope, which kills the child. `resolveSpawnCommand` is what turns the
 * configured `binaryPath` into something spawnable on every host: it resolves
 * the command against PATH/PATHEXT on Windows and falls back to shell mode for
 * `.cmd` launcher shims.
 */
const runClaudeCli = Effect.fn("runClaudeCli")(function* (input: {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}) {
  const spawnCommand = yield* resolveSpawnCommand(input.binaryPath, input.args, {
    env: input.env,
  });
  return yield* spawnAndCollect(
    input.binaryPath,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      cwd: input.cwd,
      env: input.env,
      shell: spawnCommand.shell,
    }),
    { maxOutputBytes: CLAUDE_USAGE_MAX_OUTPUT_BYTES },
  );
});

/**
 * Read the instance's subscription quota. The CLI is only asked for `/usage`
 * once it has confirmed a signed-in first-party account, so an unauthenticated
 * or cloud-provider instance is never spawned into an interactive login flow.
 */
export const probeClaudeUsage = Effect.fn("probeClaudeUsage")(function* (input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly observedAt: Date;
}) {
  const authResult = yield* runClaudeCli({
    binaryPath: input.binaryPath,
    args: ["auth", "status", "--json"],
    cwd: input.cwd,
    env: input.env,
  }).pipe(Effect.timeoutOption(CLAUDE_AUTH_STATUS_TIMEOUT_MS));

  const status =
    Option.isSome(authResult) && authResult.value.truncated !== true
      ? parseClaudeAuthStatus(authResult.value.stdout)
      : undefined;
  if (!status) {
    yield* Effect.logDebug("Claude usage probe skipped: authentication status unavailable.");
    return unknownClaudeUsage(input.observedAt);
  }
  const account = claudeUsageAccount(status);
  if (!isSubscriptionCapableAuth(status)) {
    yield* Effect.logDebug("Claude usage probe skipped: no first-party subscription session.", {
      loggedIn: status.loggedIn,
      apiProvider: status.apiProvider,
    });
    return unknownClaudeUsage(input.observedAt, account);
  }

  const usageResult = yield* runClaudeCli({
    binaryPath: input.binaryPath,
    // `--safe-mode` keeps hooks, MCP servers, plugins and CLAUDE.md out of a
    // quota read; `--no-session-persistence` keeps it out of the user's
    // resumable history; `--tools ""` leaves the CLI nothing to run even if a
    // future version stopped answering `/usage` locally.
    args: [
      "--print",
      "/usage",
      "--output-format",
      "json",
      "--safe-mode",
      "--no-session-persistence",
      "--tools",
      "",
    ],
    cwd: input.cwd,
    env: input.env,
  }).pipe(Effect.timeoutOption(CLAUDE_USAGE_PROBE_TIMEOUT_MS));

  if (Option.isNone(usageResult)) {
    yield* Effect.logWarning("Claude usage probe timed out.", {
      timeoutMs: CLAUDE_USAGE_PROBE_TIMEOUT_MS,
    });
    return unknownClaudeUsage(input.observedAt, account);
  }
  if (usageResult.value.code !== 0) {
    yield* Effect.logWarning("Claude usage probe exited with a non-zero status.", {
      code: usageResult.value.code,
      stderr: usageResult.value.stderr.slice(0, 500),
    });
    return unknownClaudeUsage(input.observedAt, account);
  }

  if (usageResult.value.truncated === true) {
    // The collector stopped retaining output, so what is in hand is a prefix of
    // whatever the CLI decided to print. A prefix is not a panel.
    yield* Effect.logWarning("Claude usage probe output exceeded its byte budget.", {
      maxOutputBytes: CLAUDE_USAGE_MAX_OUTPUT_BYTES,
    });
    return unknownClaudeUsage(input.observedAt, account);
  }

  const envelope = readClaudeUsageEnvelope(usageResult.value.stdout);
  if (envelope._tag === "rejected") {
    yield* Effect.logWarning("Claude usage probe returned an unusable panel.", {
      reason: envelope.reason,
    });
    return unknownClaudeUsage(input.observedAt, account);
  }
  return parseClaudeUsagePanel(envelope.text, input.observedAt, account);
});
