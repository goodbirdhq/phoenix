/**
 * ClaudeUsageProbe - bounded, read-only Claude Code `/usage` collection.
 *
 * Claude does not expose the rendered subscription bars through the Agent SDK.
 * The CLI's own `/usage` command is therefore the narrowest honest source: it
 * runs in the configured instance's CLAUDE_CONFIG_DIR and has no allowed tools.
 * It is deliberately on-demand, never a provider health check or agent turn.
 */
// @effect-diagnostics globalDate:off globalTimers:off
/* eslint-disable no-control-regex -- parsing PTY control sequences is the boundary's purpose. */
import type { ProviderAvailability, ProviderAvailabilityWindow } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PtyAdapter from "../../terminal/PtyAdapter.ts";

const MAX_OUTPUT_CHARS = 64_000;
export const CLAUDE_USAGE_PROBE_TIMEOUT_MS = 15_000;

const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

export const stripTerminalFormatting = (value: string): string =>
  value
    .replace(ANSI_ESCAPE, "")
    // Progress redraws use CR without LF. Keeping only the final visual line
    // avoids accidentally joining stale percentage values to fresh headings.
    .replace(/\r(?!\n)/g, "\n")
    .replace(/\u0007/g, "")
    .replace(/\u001b/g, "");

const relativeReset = (value: string, observedAt: Date): string | undefined => {
  const match = value.match(
    /(?:in\s+)?(?:(\d+)\s*(?:h|hr|hour)s?)?\s*(?:(\d+)\s*(?:m|min|minute)s?)?/i,
  );
  if (!match || (!match[1] && !match[2])) return undefined;
  const milliseconds = (Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60_000;
  return new Date(observedAt.getTime() + milliseconds).toISOString();
};

const weekdayReset = (value: string, observedAt: Date): string | undefined => {
  const match = value.match(
    /(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\s+(\d{1,2}):(\d{2})\s*(am|pm)/i,
  );
  if (!match) return undefined;
  const weekday = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(
    value.slice(0, 3).toLowerCase(),
  );
  if (weekday < 0) return undefined;
  let hour = Number(match[1]);
  if (hour === 12) hour = 0;
  if (match[3]?.toLowerCase() === "pm") hour += 12;
  const result = new Date(observedAt);
  const offset = (weekday - observedAt.getDay() + 7) % 7;
  result.setDate(result.getDate() + (offset === 0 && result.getHours() >= hour ? 7 : offset));
  result.setHours(hour, Number(match[2]), 0, 0);
  return result.toISOString();
};

const parseReset = (value: string, observedAt: Date): string | undefined =>
  relativeReset(value, observedAt) ?? weekdayReset(value, observedAt);

type UsageWindowDefinition = {
  readonly kind: string;
  readonly label: string;
  readonly scope?: string;
  readonly heading: RegExp;
};

const BASE_WINDOWS: ReadonlyArray<UsageWindowDefinition> = [
  { kind: "session", label: "Current session", heading: /Current\s+session/i },
  { kind: "weekly", label: "All models", heading: /All\s+models/i },
];

const readWindow = (
  output: string,
  definition: UsageWindowDefinition,
  observedAt: Date,
): ProviderAvailabilityWindow | undefined => {
  const headingMatch = definition.heading.exec(output);
  if (!headingMatch || headingMatch.index === undefined) return undefined;
  // Restrict a window to its nearby visual block. This prevents the current
  // session label from accidentally borrowing the next weekly percentage.
  const block = output.slice(headingMatch.index, headingMatch.index + 600);
  const percent = block.match(/(\d{1,3})\s*%\s*used/i);
  if (!percent) return undefined;
  const usedPercent = Number(percent[1]);
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return undefined;
  const reset = block.match(/Resets?\s+([^\n]+)/i);
  const resetsAt = reset ? parseReset(reset[1] ?? "", observedAt) : undefined;
  return {
    kind: definition.kind,
    label: definition.label,
    ...(definition.scope ? { scope: definition.scope } : {}),
    usedPercent,
    ...(resetsAt ? { resetsAt } : {}),
  };
};

/** Parse the CLI's rendered `/usage` panel without deriving quota from tokens. */
export const parseClaudeUsage = (
  rawOutput: string,
  observedAt = new Date(),
): ProviderAvailability => {
  const output = stripTerminalFormatting(rawOutput);
  const windows: ProviderAvailabilityWindow[] = BASE_WINDOWS.flatMap((definition) => {
    const window = readWindow(output, definition, observedAt);
    return window ? [window] : [];
  });

  // Model-specific weekly rows are intentionally discovered from rendered
  // headings rather than a hard-coded model list: a future plan can add a
  // named pool without Phoenix claiming it is the all-models weekly quota.
  const modelPattern =
    /(?:^|\n)\s*([A-Za-z][A-Za-z0-9 ._-]{1,60})\s*\n[\s\S]{0,220}?(\d{1,3})\s*%\s*used[\s\S]{0,160}?Resets?\s+([^\n]+)/g;
  for (const match of output.matchAll(modelPattern)) {
    const label = match[1]?.trim();
    const usedPercent = Number(match[2]);
    if (
      !label ||
      /^(Current session|Weekly limits|All models|Plan usage limits)$/i.test(label) ||
      !Number.isFinite(usedPercent) ||
      usedPercent < 0 ||
      usedPercent > 100
    ) {
      continue;
    }
    const scope = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (windows.some((window) => window.kind === "model-weekly" && window.scope === scope))
      continue;
    const resetsAt = parseReset(match[3] ?? "", observedAt);
    windows.push({
      kind: "model-weekly",
      label,
      scope,
      usedPercent,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return {
    status: windows.some((window) => window.usedPercent >= 100)
      ? "limited"
      : windows.length > 0
        ? "available"
        : "unknown",
    source: "claude_cli_usage",
    observedAt: observedAt.toISOString(),
    windows,
  };
};

export const probeClaudeUsage = Effect.fn("probeClaudeUsage")(function* (input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly observedAt?: Date;
}) {
  const pty = yield* PtyAdapter.PtyAdapter;
  const process = yield* pty.spawn({
    shell: input.binaryPath,
    args: ["--allowed-tools", ""],
    cwd: input.cwd,
    cols: 120,
    rows: 40,
    env: input.env,
  });
  const output: string[] = [];
  const result = yield* Effect.callback<ProviderAvailability>((resume) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      unsubscribeData();
      unsubscribeExit();
      process.kill();
      resume(Effect.succeed(parseClaudeUsage(output.join(""), input.observedAt)));
    };
    const unsubscribeData = process.onData((chunk) => {
      if (output.join("").length < MAX_OUTPUT_CHARS) output.push(chunk.slice(0, MAX_OUTPUT_CHARS));
      // The panel is rendered after /usage. Its footer is a stable completion
      // marker, so we do not wait for a provider turn or a polling timer.
      if (/Last updated:/i.test(output.join(""))) finish();
    });
    const unsubscribeExit = process.onExit(() => finish());
    process.write("/usage\r");
    return Effect.sync(() => {
      if (!settled) process.kill();
      unsubscribeData();
      unsubscribeExit();
    });
  }).pipe(
    Effect.timeoutOption(CLAUDE_USAGE_PROBE_TIMEOUT_MS),
    Effect.map((value) =>
      Option.isSome(value) ? value.value : parseClaudeUsage("", input.observedAt),
    ),
  );
  return result;
});
