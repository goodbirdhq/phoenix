/**
 * These tests run against `testFixtures/claudeUsagePrint.json`, a live capture
 * from an authenticated Claude Code CLI (see its `capturedWith` block). The
 * panel is verbatim, so the prose rows it contains are exactly what a real
 * parser has to refuse to read as quota.
 */
// @effect-diagnostics globalDate:off
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import usageFixture from "../testFixtures/claudeUsagePrint.json" with { type: "json" };
import {
  CLAUDE_USAGE_MAX_OUTPUT_BYTES,
  claudeUsageAccount,
  claudeUsageProbeArgs,
  parseClaudeAuthStatus,
  parseClaudeUsagePanel,
  parseClaudeUsageReset,
  probeClaudeUsage,
  readClaudeUsageEnvelope,
  stripTerminalFormatting,
} from "./ClaudeUsageProbe.ts";

const observedAt = new Date("2026-08-17T20:45:00.000Z");
const panel = usageFixture.usageEnvelope.result;
const usageEnvelopeJson = JSON.stringify(usageFixture.usageEnvelope);
const authStatusJson = JSON.stringify(usageFixture.authStatus);
/** The same captured panel as a Windows CLI would print it. */
const crlfUsageEnvelopeJson = JSON.stringify({
  ...usageFixture.usageEnvelope,
  result: usageFixture.usageEnvelope.result.replace(/\n/g, "\r\n"),
});

const LOGGED_OUT_STATUS_JSON = '{"loggedIn": false}';
const BEDROCK_STATUS_JSON =
  '{"loggedIn": true, "email": "who@example.com", "apiProvider": "bedrock"}';

const account = {
  id: "claude:00000000-0000-4000-8000-000000000000:maintainer@example.com",
  verification: "native_verified",
  displayName: "maintainer@example.com",
} as const;

describe("parseClaudeUsagePanel", () => {
  it("reads every rendered quota row from the captured panel", () => {
    expect(parseClaudeUsagePanel(panel, observedAt)).toEqual({
      status: "available",
      source: "claude_cli_usage",
      observedAt: "2026-08-17T20:45:00.000Z",
      windows: [
        {
          kind: "session",
          label: "Current session",
          usedPercent: 5,
          // Aug 18, 1am Europe/Berlin (UTC+2 in August).
          resetsAt: "2026-08-17T23:00:00.000Z",
        },
        {
          kind: "weekly",
          label: "All models",
          scope: "all-models",
          usedPercent: 77,
          resetsAt: "2026-08-18T19:00:00.000Z",
        },
        {
          kind: "model-weekly",
          label: "Fable",
          scope: "fable",
          usedPercent: 72,
          resetsAt: "2026-08-18T19:00:00.000Z",
        },
      ],
    });
  });

  it("never turns the panel's prose percentages into windows", () => {
    // The captured panel contains rows such as "75% of your usage was at >150k
    // context" and "Top skills: /agent-browser 15%, /coolify-server 7%".
    expect(panel).toContain("% of your usage was at >150k context");
    expect(panel).toContain("Top skills:");
    expect(parseClaudeUsagePanel(panel, observedAt).windows).toHaveLength(3);
  });

  it("keeps each row's percentage and reset on that row", () => {
    const availability = parseClaudeUsagePanel(
      ["Current session: 4% used", "Current week (all models): 100% used · resets in 2h"].join(
        "\n",
      ),
      observedAt,
    );
    expect(availability).toEqual({
      status: "limited",
      source: "claude_cli_usage",
      observedAt: "2026-08-17T20:45:00.000Z",
      windows: [
        { kind: "session", label: "Current session", usedPercent: 4 },
        {
          kind: "weekly",
          label: "All models",
          scope: "all-models",
          usedPercent: 100,
          resetsAt: "2026-08-17T22:45:00.000Z",
        },
      ],
    });
  });

  it("reports unknown rather than an empty quota when nothing is rendered", () => {
    expect(parseClaudeUsagePanel("You are not logged in.", observedAt)).toEqual({
      status: "unknown",
      source: "claude_cli_usage",
      observedAt: "2026-08-17T20:45:00.000Z",
      windows: [],
    });
  });

  it("drops rows it cannot name and rows outside 0-100", () => {
    expect(
      parseClaudeUsagePanel(
        ["Mystery pool: 42% used", "Current session: 142% used"].join("\n"),
        observedAt,
      ).windows,
    ).toEqual([]);
  });

  it("keeps the first reading when the CLI repeats a row", () => {
    expect(
      parseClaudeUsagePanel(
        ["Current session: 4% used", "Current session: 99% used"].join("\n"),
        observedAt,
      ).windows,
    ).toEqual([{ kind: "session", label: "Current session", usedPercent: 4 }]);
  });

  it("carries a verified account onto the snapshot", () => {
    expect(parseClaudeUsagePanel(panel, observedAt, account).account).toEqual(account);
  });

  it("reads fractional percentages instead of dropping the row", () => {
    expect(
      parseClaudeUsagePanel(
        [
          "Current session: 0.5% used",
          "Current week (all models): 33.333% used",
          // A comma-decimal locale renders the same reading this way.
          "Current week (Fable): 7,25% used",
        ].join("\n"),
        observedAt,
      ).windows,
    ).toEqual([
      { kind: "session", label: "Current session", usedPercent: 0.5 },
      { kind: "weekly", label: "All models", scope: "all-models", usedPercent: 33.3 },
      { kind: "model-weekly", label: "Fable", scope: "fable", usedPercent: 7.3 },
    ]);
  });

  it("still reads a fractional row as reaching the limit", () => {
    expect(parseClaudeUsagePanel("Current session: 100.0% used", observedAt)).toMatchObject({
      status: "limited",
      windows: [{ kind: "session", usedPercent: 100 }],
    });
    expect(parseClaudeUsagePanel("Current session: 100.4% used", observedAt).windows).toEqual([]);
  });

  it("keeps every weekly pool the panel renders", () => {
    // The shared weekly pool and a per-model pool are different quotas. Before
    // weekly rows carried a scope, they shared one dedupe identity and the
    // second row rendered was silently dropped.
    expect(
      parseClaudeUsagePanel(
        [
          "Current week: 40% used",
          "Current week (Fable): 12% used",
          "Current week (Opus 4.5): 3% used",
        ].join("\n"),
        observedAt,
      ).windows,
    ).toEqual([
      { kind: "weekly", label: "Current week", scope: "all-models", usedPercent: 40 },
      { kind: "model-weekly", label: "Fable", scope: "fable", usedPercent: 12 },
      { kind: "model-weekly", label: "Opus 4.5", scope: "opus-4-5", usedPercent: 3 },
    ]);
  });

  it("treats both wordings of the shared weekly pool as one pool", () => {
    expect(
      parseClaudeUsagePanel(
        ["Current week: 40% used", "Current week (all models): 41% used"].join("\n"),
        observedAt,
      ).windows,
    ).toEqual([{ kind: "weekly", label: "Current week", scope: "all-models", usedPercent: 40 }]);
  });

  it("gives every window a render key no other window shares", () => {
    const windows = parseClaudeUsagePanel(panel, observedAt).windows;
    const keys = windows.map((window) => `${window.kind}:${window.scope ?? ""}`);
    expect(new Set(keys).size).toBe(windows.length);
  });
});

describe("parseClaudeUsageReset", () => {
  it("resolves the CLI's zoned wall-clock wording", () => {
    expect(parseClaudeUsageReset("· resets Aug 18, 12:59am (Europe/Berlin)", observedAt)).toBe(
      "2026-08-17T22:59:00.000Z",
    );
    expect(parseClaudeUsageReset("· resets Aug 18, 9pm (America/New_York)", observedAt)).toBe(
      "2026-08-19T01:00:00.000Z",
    );
  });

  it("rolls into the next year when the rendered date already passed", () => {
    expect(
      parseClaudeUsageReset(
        "· resets Jan 2, 9am (Europe/Berlin)",
        new Date("2026-12-31T12:00:00.000Z"),
      ),
    ).toBe("2027-01-02T08:00:00.000Z");
  });

  it("still reads relative wording", () => {
    expect(parseClaudeUsageReset("resets in 4h 52m", observedAt)).toBe("2026-08-18T01:37:00.000Z");
    expect(parseClaudeUsageReset("resets in 45 minutes", observedAt)).toBe(
      "2026-08-17T21:30:00.000Z",
    );
  });

  it("returns nothing for wording it does not understand", () => {
    expect(parseClaudeUsageReset("resets soon", observedAt)).toBeUndefined();
    expect(parseClaudeUsageReset("resets Aug 18, 9pm (Mars/Olympus)", observedAt)).toBeUndefined();
  });
});

describe("readClaudeUsageEnvelope", () => {
  it("accepts the captured envelope, which the CLI answered without a turn", () => {
    expect(usageFixture.usageEnvelope.num_turns).toBe(0);
    expect(usageFixture.usageEnvelope.total_cost_usd).toBe(0);
    expect(readClaudeUsageEnvelope(usageEnvelopeJson)).toEqual({ _tag: "panel", text: panel });
  });

  it("rejects a panel the CLI charged an agent turn for", () => {
    expect(
      readClaudeUsageEnvelope(
        JSON.stringify({ ...usageFixture.usageEnvelope, num_turns: 1, total_cost_usd: 0.02 }),
      ),
    ).toEqual({ _tag: "rejected", reason: "CLI did not report /usage as a zero-turn read" });
    expect(
      readClaudeUsageEnvelope(JSON.stringify({ ...usageFixture.usageEnvelope, total_cost_usd: 1 })),
    ).toEqual({ _tag: "rejected", reason: "CLI did not report /usage as a zero-cost read" });
  });

  it("requires both counters to be reported, as finite numeric zeroes", () => {
    // The claim "reading quota is free" rests entirely on these two counters,
    // so a counter the CLI stopped reporting — or reported in a shape this
    // parser would have to interpret — is not evidence of anything.
    const withoutTurns = { ...usageFixture.usageEnvelope } as Record<string, unknown>;
    delete withoutTurns.num_turns;
    expect(readClaudeUsageEnvelope(JSON.stringify(withoutTurns))).toEqual({
      _tag: "rejected",
      reason: "CLI did not report /usage as a zero-turn read",
    });

    const withoutCost = { ...usageFixture.usageEnvelope } as Record<string, unknown>;
    delete withoutCost.total_cost_usd;
    expect(readClaudeUsageEnvelope(JSON.stringify(withoutCost))).toEqual({
      _tag: "rejected",
      reason: "CLI did not report /usage as a zero-cost read",
    });

    for (const num_turns of ["0", null, true, [], {}]) {
      expect(
        readClaudeUsageEnvelope(JSON.stringify({ ...usageFixture.usageEnvelope, num_turns })),
      ).toEqual({ _tag: "rejected", reason: "CLI did not report /usage as a zero-turn read" });
    }
    for (const total_cost_usd of ["0", null, -0.01]) {
      expect(
        readClaudeUsageEnvelope(JSON.stringify({ ...usageFixture.usageEnvelope, total_cost_usd })),
      ).toEqual({ _tag: "rejected", reason: "CLI did not report /usage as a zero-cost read" });
    }
    // JSON has no literal for a non-finite number, but a CLI can still print
    // one through a lenient encoder.
    expect(
      readClaudeUsageEnvelope(
        JSON.stringify(usageFixture.usageEnvelope).replace('"num_turns":0', '"num_turns":1e999'),
      ),
    ).toEqual({ _tag: "rejected", reason: "CLI did not report /usage as a zero-turn read" });
  });

  it("rejects error envelopes, non-JSON output, and oversized output", () => {
    expect(
      readClaudeUsageEnvelope(JSON.stringify({ ...usageFixture.usageEnvelope, is_error: true })),
    ).toEqual({ _tag: "rejected", reason: "CLI reported an error for /usage" });
    expect(readClaudeUsageEnvelope("Invalid API key")).toEqual({
      _tag: "rejected",
      reason: "usage output was not a JSON envelope",
    });
    expect(readClaudeUsageEnvelope("x".repeat(64_001))).toEqual({
      _tag: "rejected",
      reason: "usage output exceeded the expected size",
    });
  });
});

describe("stripTerminalFormatting", () => {
  it("removes colour and keeps only the last write of a redrawn line", () => {
    expect(stripTerminalFormatting("\u001B[2K\rCurrent session: 4% used")).toBe(
      "Current session: 4% used",
    );
    expect(stripTerminalFormatting("Current session: 99% used\rCurrent session: 4% used")).toBe(
      "Current session: 4% used",
    );
  });

  it("reads a CRLF panel as lines, not as lines rewritten to nothing", () => {
    // A Windows CLI ends every line with CRLF. Treating that trailing carriage
    // return as a redraw would leave the empty string after it as each line's
    // final frame and erase the whole panel.
    expect(stripTerminalFormatting("Current session: 4% used\r\nCurrent week: 10% used\r\n")).toBe(
      "Current session: 4% used\nCurrent week: 10% used\n",
    );
    expect(
      stripTerminalFormatting("Current session: 99% used\rCurrent session: 4% used\r\nrest"),
    ).toBe("Current session: 4% used\nrest");
  });

  it("keeps the text of a line that ends by returning the cursor", () => {
    expect(stripTerminalFormatting("Current session: 4% used\r")).toBe("Current session: 4% used");
  });
});

describe("parseClaudeUsagePanel on a CRLF host", () => {
  it("reads the same quota rows a LF host reads", () => {
    const windows = parseClaudeUsagePanel(panel.replace(/\n/g, "\r\n"), observedAt).windows;
    expect(windows).toEqual(parseClaudeUsagePanel(panel, observedAt).windows);
    expect(windows.length).toBeGreaterThan(0);
  });
});

describe("claudeUsageProbeArgs", () => {
  it("keeps the variadic --tools last so nothing can be read as a tool name", () => {
    const args = claudeUsageProbeArgs();
    // `--tools` swallows every following argument. Anything after its single
    // empty value would silently become a tool the quota read may run.
    expect(args.filter((arg) => arg === "--tools")).toHaveLength(1);
    expect(args.indexOf("--tools")).toBe(args.length - 2);
    expect(args.at(-1)).toBe("");
    // ...and the prompt has to be read as the prompt, not as a tool name.
    expect(args.indexOf("/usage")).toBeLessThan(args.indexOf("--tools"));
    expect(args.indexOf("/usage")).toBeGreaterThan(-1);
  });

  it("asks for a read that cannot touch the user's project or history", () => {
    expect(claudeUsageProbeArgs()).toEqual([
      "--print",
      "/usage",
      "--output-format",
      "json",
      "--safe-mode",
      "--no-session-persistence",
      "--tools",
      "",
    ]);
  });
});

describe("claudeUsageAccount", () => {
  it("publishes the CLI's own signed-in first-party account", () => {
    const status = parseClaudeAuthStatus(authStatusJson);
    expect(status).toEqual({
      loggedIn: true,
      email: "maintainer@example.com",
      orgId: "00000000-0000-4000-8000-000000000000",
      apiProvider: "firstParty",
      subscriptionType: "max",
    });
    expect(claudeUsageAccount(status)).toEqual(account);
  });

  it("publishes no identity for logged-out or cloud-provider instances", () => {
    expect(claudeUsageAccount(parseClaudeAuthStatus(LOGGED_OUT_STATUS_JSON))).toBe(undefined);
    expect(claudeUsageAccount(parseClaudeAuthStatus(BEDROCK_STATUS_JSON))).toBe(undefined);
    expect(parseClaudeAuthStatus("claude: command not found")).toBe(undefined);
    expect(parseClaudeAuthStatus("x".repeat(64_001))).toBe(undefined);
  });
});

type FakeRun = {
  readonly stdout: string;
  readonly stderr?: string;
  readonly code?: number;
};

function makeFakeCli(runs: ReadonlyArray<FakeRun>) {
  const commands: Array<ReadonlyArray<string>> = [];
  const cwds: Array<string | undefined> = [];
  let index = 0;
  const spawner = ChildProcessSpawner.make((command) => {
    const spawned = command as unknown as {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly options: { readonly cwd?: string };
    };
    commands.push([spawned.command, ...spawned.args]);
    cwds.push(spawned.options.cwd);
    const run = runs[index++] ?? { stdout: "" };
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(run.code ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(run.stdout)),
        stderr: Stream.encodeText(Stream.make(run.stderr ?? "")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { spawner, commands, cwds };
}

const runProbe = (cli: ReturnType<typeof makeFakeCli>) =>
  probeClaudeUsage({
    binaryPath: "claude",
    cwd: "/tmp/phoenix-claude-usage-probe",
    env: { CLAUDE_CONFIG_DIR: "/tmp/phoenix-claude-home" },
    observedAt,
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, cli.spawner));

describe("probeClaudeUsage", () => {
  it.effect("asks the CLI for its own usage panel, non-interactively", () =>
    Effect.gen(function* () {
      const cli = makeFakeCli([{ stdout: authStatusJson }, { stdout: usageEnvelopeJson }]);
      const availability = yield* runProbe(cli);

      expect(cli.commands).toEqual([
        ["claude", "auth", "status", "--json"],
        [
          "claude",
          "--print",
          "/usage",
          "--output-format",
          "json",
          "--safe-mode",
          "--no-session-persistence",
          "--tools",
          "",
        ],
      ]);
      expect(cli.cwds).toEqual([
        "/tmp/phoenix-claude-usage-probe",
        "/tmp/phoenix-claude-usage-probe",
      ]);
      expect(availability).toEqual({
        status: "available",
        source: "claude_cli_usage",
        observedAt: "2026-08-17T20:45:00.000Z",
        account,
        windows: [
          {
            kind: "session",
            label: "Current session",
            usedPercent: 5,
            resetsAt: "2026-08-17T23:00:00.000Z",
          },
          {
            kind: "weekly",
            label: "All models",
            scope: "all-models",
            usedPercent: 77,
            resetsAt: "2026-08-18T19:00:00.000Z",
          },
          {
            kind: "model-weekly",
            label: "Fable",
            scope: "fable",
            usedPercent: 72,
            resetsAt: "2026-08-18T19:00:00.000Z",
          },
        ],
      });
    }),
  );

  it.effect("never runs /usage for a logged-out CLI", () =>
    Effect.gen(function* () {
      const cli = makeFakeCli([{ stdout: LOGGED_OUT_STATUS_JSON }]);
      const availability = yield* runProbe(cli);

      expect(cli.commands).toEqual([["claude", "auth", "status", "--json"]]);
      expect(availability).toEqual({
        status: "unknown",
        source: "claude_cli_usage",
        observedAt: "2026-08-17T20:45:00.000Z",
        windows: [],
      });
    }),
  );

  it.effect("never runs /usage for a cloud-provider instance", () =>
    Effect.gen(function* () {
      const cli = makeFakeCli([{ stdout: BEDROCK_STATUS_JSON }]);
      const availability = yield* runProbe(cli);

      expect(cli.commands).toEqual([["claude", "auth", "status", "--json"]]);
      expect(availability.status).toBe("unknown");
      expect(availability.account).toBe(undefined);
    }),
  );

  it.effect("reads an unusable panel as unknown, never as an empty quota", () =>
    Effect.gen(function* () {
      const cli = makeFakeCli([{ stdout: authStatusJson }, { stdout: "Invalid API key" }]);
      const availability = yield* runProbe(cli);

      expect(availability).toEqual({
        status: "unknown",
        source: "claude_cli_usage",
        observedAt: "2026-08-17T20:45:00.000Z",
        account,
        windows: [],
      });
    }),
  );

  it.effect("stops retaining output from a CLI that will not stop writing", () =>
    Effect.gen(function* () {
      // A prefix of an envelope is not an envelope: the reading is unknown, and
      // the collector never held more than its cap regardless of how much the
      // CLI printed before its timeout.
      const flood = `{"num_turns":0,"total_cost_usd":0,"result":"${"Current session: 4% used ".repeat(
        200_000,
      )}"}`;
      expect(flood.length).toBeGreaterThan(CLAUDE_USAGE_MAX_OUTPUT_BYTES);
      const cli = makeFakeCli([{ stdout: authStatusJson }, { stdout: flood }]);
      const availability = yield* runProbe(cli);

      expect(availability).toEqual({
        status: "unknown",
        source: "claude_cli_usage",
        observedAt: "2026-08-17T20:45:00.000Z",
        account,
        windows: [],
      });
    }),
  );

  it.effect("keeps the account but reports unknown when the panel call fails", () =>
    Effect.gen(function* () {
      const cli = makeFakeCli([
        { stdout: authStatusJson },
        { stdout: "", stderr: "usage unavailable", code: 1 },
      ]);
      const availability = yield* runProbe(cli);

      expect(availability).toEqual({
        status: "unknown",
        source: "claude_cli_usage",
        observedAt: "2026-08-17T20:45:00.000Z",
        account,
        windows: [],
      });
    }),
  );

  it.effect("never trusts an auth status the CLI reported as failed", () =>
    Effect.gen(function* () {
      // A failed `auth status` can still print something that parses as JSON -
      // a cached or half-written answer. Publishing a verified account from it,
      // and then running `/usage` on the strength of it, is exactly what the
      // exit code is there to prevent.
      const cli = makeFakeCli([
        { stdout: authStatusJson, stderr: "not logged in", code: 1 },
        { stdout: usageEnvelopeJson },
      ]);
      const availability = yield* runProbe(cli);

      expect(cli.commands).toEqual([["claude", "auth", "status", "--json"]]);
      expect(availability).toEqual({
        status: "unknown",
        source: "claude_cli_usage",
        observedAt: "2026-08-17T20:45:00.000Z",
        windows: [],
      });
      expect(availability.account).toBe(undefined);
    }),
  );

  it.effect("reads a CRLF panel exactly as it reads a LF one", () =>
    Effect.gen(function* () {
      const cli = makeFakeCli([{ stdout: authStatusJson }, { stdout: crlfUsageEnvelopeJson }]);
      const availability = yield* runProbe(cli);

      expect(availability.status).toBe("available");
      expect(availability.windows).toEqual(parseClaudeUsagePanel(panel, observedAt).windows);
    }),
  );
});
