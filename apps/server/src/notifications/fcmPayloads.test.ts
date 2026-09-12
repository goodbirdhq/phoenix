import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AgentActivityState } from "@t3tools/contracts/notifications";
import * as Schema from "effect/Schema";
import { makeAggregateState } from "./agentActivityAggregate.ts";
import { androidActivityData, fitFcmData } from "./fcmPayloads.ts";
const aggregateFor = (states: ReadonlyArray<AgentActivityState>) =>
  makeAggregateState({ activeStates: states, terminalState: null, nowMs: 0 })!;

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const state: AgentActivityState = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  projectTitle: "Project",
  threadTitle: "Fix notifications",
  phase: "running",
  headline: "Working",
  modelTitle: "Codex",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/threads/env/thread",
};
const secondState: AgentActivityState = {
  ...state,
  threadId: ThreadId.make("second"),
  threadTitle: "Second thread",
};
describe("Android activity payload compatibility", () => {
  it("shows five rows with attention then failure first, including project and status", () => {
    const aggregate = aggregateFor([
      state,
      { ...secondState, phase: "failed" },
      { ...state, threadId: ThreadId.make("approval"), phase: "waiting_for_approval" },
      { ...state, threadId: ThreadId.make("input"), phase: "waiting_for_input" },
      { ...state, threadId: ThreadId.make("done"), phase: "completed" },
    ]);
    const data = androidActivityData(aggregate);
    expect(data.activity_title).toBe("3 active agents · 2 need attention");
    expect(
      Object.entries(data)
        .filter(([key]) => key.startsWith("activity_line_"))
        .map(([, value]) => value),
    ).toEqual([
      "Approval\tFix notifications\tProject",
      "Input\tFix notifications\tProject",
      "Failed\tSecond thread\tProject",
      "Working\tFix notifications\tProject",
      "Done\tFix notifications\tProject",
    ]);
    expect(data.activity_expires_at).toBe(String(24 * 60 * 60 * 1000));
    expect(androidActivityData(aggregateFor([state])).activity_expires_at).toBe(
      String(2 * 60 * 60 * 1000),
    );
  });

  it("fits five Unicode rows and a grouped alert in the FCM budget without corrupting text or routes", () => {
    const longTitle = '🤖漢字"\\'.repeat(30);
    const aggregate = aggregateFor(
      Array.from({ length: 5 }, (_, i) => ({
        ...state,
        threadId: ThreadId.make(`thread-${i}`),
        threadTitle: longTitle,
        projectTitle: longTitle,
      })),
    );
    const data = fitFcmData({
      ...androidActivityData(aggregate),
      t3_kind: "agent_activity",
      device_id: "d".repeat(128),
      user_id: "u".repeat(128),
      updated_at: "1788780000000",
      alert_id: "a".repeat(64),
      alert_title: "5 agents finished",
      alert_body: Array(5).fill(longTitle).join(", "),
      alert_path: "/threads/env/thread",
    });
    expect(new TextEncoder().encode(JSON.stringify(data)).length).toBeLessThanOrEqual(3800);
    expect(data.alert_path).toBe("/threads/env/thread");
    expect(data.activity_path).toBe("/threads/env/thread");
    expect(data.alert_id).toBe("a".repeat(64));
    expect(data.activity_line_4).toContain("Working\t");
    for (const value of Object.values(data))
      expect(new TextDecoder().decode(new TextEncoder().encode(value))).toBe(value);
  });
});
it("continues shrinking text when a longer activity line is already minimal", () => {
  const data = fitFcmData({
    activity_line_0: "Approval\t😀😀😀😀\t😀😀😀😀",
    alert_body: "x".repeat(30),
    device_id: "x".repeat(3680),
  });
  expect(new TextEncoder().encode(encodeJson(data)).length).toBeLessThanOrEqual(3800);
  expect(data.activity_line_0).toBe("Approval\t😀😀😀😀\t😀😀😀😀");
});

it("stops reducing five-character row fields and fits the remaining alert", () => {
  const data = fitFcmData({
    device_id: "x".repeat(3710),
    activity_line_0: "Approval\taaaaa\tbbbbb",
    alert_body: "y".repeat(200),
  });
  expect(data.activity_line_0).toBe("Approval\taaaaa\tbbbbb");
  expect(new TextEncoder().encode(encodeJson(data)).length).toBeLessThanOrEqual(3800);
});
