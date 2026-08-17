// @effect-diagnostics globalDate:off
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as PtyAdapter from "../../terminal/PtyAdapter.ts";
import { parseClaudeUsage, probeClaudeUsage, stripTerminalFormatting } from "./ClaudeUsageProbe.ts";

const observedAt = new Date("2026-08-17T10:00:00.000Z");

describe("ClaudeUsageProbe", () => {
  it("parses terminal-coloured five-hour, all-models, and Fable weekly bars", () => {
    const availability = parseClaudeUsage(
      "\u001b[33mCurrent session\u001b[0m\nResets in 4 hr 52 min\n0% used\n" +
        "Weekly limits\nAll models\n76% used\nResets Tue 8:00 PM\n" +
        "Fable\n72% used\nResets Tue 8:00 PM\nLast updated: just now",
      observedAt,
    );
    expect(availability).toMatchObject({ status: "available", source: "claude_cli_usage" });
    expect(availability.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "session", usedPercent: 0 }),
        expect.objectContaining({ kind: "weekly", usedPercent: 76 }),
        expect.objectContaining({
          kind: "model-weekly",
          label: "Fable",
          scope: "fable",
          usedPercent: 72,
        }),
      ]),
    );
  });

  it("returns honest unknown when the panel contains no numeric quota", () => {
    expect(parseClaudeUsage("Plan usage limits\nNot logged in", observedAt)).toMatchObject({
      status: "unknown",
      windows: [],
    });
  });

  it("removes ANSI redraw formatting without manufacturing a quota", () => {
    expect(stripTerminalFormatting("\u001b[2K\rCurrent session")).toContain("Current session");
  });

  it.effect("uses a restricted CLI PTY and captures the panel", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const pty = PtyAdapter.PtyAdapter.of({
        spawn: () =>
          Effect.sync(() => {
            let onData = (_data: string) => {};
            let _onExit = (_event: { exitCode: number; signal: number | null }) => {};
            return {
              pid: 42,
              write: (data: string) => {
                writes.push(data);
                onData("Current session\n0% used\nResets in 5 hr\nLast updated: just now");
              },
              resize: () => {},
              kill: () => {},
              onData: (callback: (data: string) => void) => {
                onData = callback;
                return () => {};
              },
              onExit: (callback: (event: { exitCode: number; signal: number | null }) => void) => {
                _onExit = callback;
                return () => {};
              },
            };
          }),
      });
      const availability = yield* probeClaudeUsage({
        binaryPath: "claude",
        cwd: "/tmp/phoenix-usage-probe",
        env: {},
        observedAt,
      }).pipe(Effect.provideService(PtyAdapter.PtyAdapter, pty));
      expect(writes).toEqual(["/usage\r"]);
      expect(availability.windows[0]).toMatchObject({ kind: "session", usedPercent: 0 });
    }),
  );
});
