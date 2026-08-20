import type { workflowModeEnum } from "../db/schema.ts";

export type RunPromptMode = (typeof workflowModeEnum.enumValues)[number];

export interface BuildRunPromptInput {
  workflow: { key: string; title: string };
  run: { id: string; mode: RunPromptMode; input: unknown };
  /** The workflow's SKILL.md body, embedded verbatim. */
  skillMarkdown: string;
  /** Absolute URL of this run's result callback (`OPS_PUBLIC_URL` + path). */
  callbackUrl: string;
  /** Raw bearer token for the callback; never logged, only ever placed in this prompt. */
  callbackToken: string;
}

const MAX_RESULT_PAYLOAD_BYTES = 64 * 1024;

/**
 * Assembles the turn text sent to the Phoenix agent for one workflow run.
 * Pure and deterministic given its input — no I/O, no clock reads beyond
 * what the caller already resolved — so it is fully unit-testable.
 */
export function buildRunPrompt(input: BuildRunPromptInput): string {
  const { workflow, run, skillMarkdown, callbackUrl, callbackToken } = input;

  const sections: string[] = [
    `# Ops workflow run\n\nYou are executing ops workflow \`${workflow.key}\` (run \`${run.id}\`) in **${run.mode}** mode.`,
  ];

  if (run.mode === "shadow") {
    sections.push(
      [
        "## Shadow mode — no external side effects",
        "",
        "This run is in **shadow** mode: do not perform any external side effect",
        "(no emails, no CRM writes, no messages sent, no third-party API calls that",
        "change state). Instead, for every side effect you would have performed,",
        "record it in your result payload under a `shadowedEffects` array — one",
        "entry per action, with enough detail to reconstruct what would have",
        "happened.",
      ].join("\n"),
    );
  }

  sections.push(["## Workflow instructions", "", skillMarkdown.trim()].join("\n"));

  sections.push(
    ["## Run input", "", "```json", JSON.stringify(run.input ?? null, null, 2), "```"].join("\n"),
  );

  sections.push(
    [
      "## Completion protocol",
      "",
      "When you are finished (whether you succeeded or failed), report the",
      `result by POSTing JSON to \`${callbackUrl}\`:`,
      "",
      "```",
      `POST ${callbackUrl}`,
      "Authorization: Bearer <token>",
      "Content-Type: application/json",
      "",
      '{"status": "succeeded" | "failed", "result"?: <any JSON value>, "error"?: "<message, if failed>"}',
      "```",
      "",
      "For example:",
      "",
      "```sh",
      `curl -X POST '${callbackUrl}' \\`,
      `  -H 'Authorization: Bearer ${callbackToken}' \\`,
      "  -H 'Content-Type: application/json' \\",
      `  -d '{"status": "succeeded", "result": {"...": "..."}}'`,
      "```",
      "",
      "This callback is the primary result channel — send it even if you also",
      "post a session report through the sessions MCP toolkit, if available in",
      "this harness. Keep the `result` payload under" +
        ` ${MAX_RESULT_PAYLOAD_BYTES / 1024}KB when JSON-encoded; summarize` +
        " rather than embed large artifacts.",
    ].join("\n"),
  );

  return sections.join("\n\n") + "\n";
}
