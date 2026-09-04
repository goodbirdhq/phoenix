import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { projectActivityPayload } from "./ActivityPayloadProjection.ts";

function activity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: "activity-1",
    tone: "tool",
    kind: "tool.completed",
    summary: "Tool",
    payload,
    turnId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

/**
 * Wire-survival regression: the slimming pass rewrites payload.data but must
 * never strip the top-level per-agent fields the subagent fold depends on.
 * If slimming ever moves to an allowlist over the whole payload, these
 * assertions are the tripwire.
 */
describe("projectActivityPayload", () => {
  it("preserves tool attribution (agentId/parentToolUseId) through data slimming", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        agentId: "task-123",
        parentToolUseId: "toolu_abc",
        data: {
          toolName: "Bash",
          input: { command: "ls" },
          command: "ls",
          rawOutput: { content: "x".repeat(10) },
          somethingClientNeverReads: { big: "blob" },
        },
      }),
    );
    const payload = projected.payload as Record<string, unknown>;
    expect(payload.agentId).toBe("task-123");
    expect(payload.parentToolUseId).toBe("toolu_abc");
    // Slimming itself still applies to data.
    const data = payload.data as Record<string, unknown>;
    expect(data.somethingClientNeverReads).toBeUndefined();
  });

  it("keeps a bounded Codex command output summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          item: {
            command: "/bin/zsh -lc 'printf hello'",
            aggregatedOutput: `hello from codex\n${"x".repeat(5000)}`,
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.item).toEqual({
      command: "/bin/zsh -lc 'printf hello'",
      aggregatedOutput: "hello from codex",
    });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("keeps bounded Claude and ACP command output summaries", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          rawOutput: { stdout: `hello from claude\n${"y".repeat(5000)}` },
        },
      }),
    );
    const acp = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          content: [
            {
              type: "content",
              content: { type: "text", text: `hello from acp\n${"z".repeat(5000)}` },
            },
          ],
        },
      }),
    );

    const claudeData = (claude.payload as Record<string, unknown>).data as Record<string, unknown>;
    const acpData = (acp.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(claudeData.rawOutput).toEqual({ content: "hello from claude" });
    expect(acpData.rawOutput).toEqual({ content: "hello from acp" });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(500);
    expect(JSON.stringify(acp.payload).length).toBeLessThan(500);
  });

  it("normalizes Claude and OpenCode command inputs before slimming provider data", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "claude-call-1",
        data: {
          toolName: "Bash",
          input: { command: "vp test run" },
          result: { content: "x".repeat(5_000) },
        },
      }),
    );
    const openCode = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "opencode-call-1",
        data: {
          tool: "bash",
          state: {
            status: "running",
            input: { command: "vp lint" },
            output: "x".repeat(5_000),
          },
        },
      }),
    );

    expect(claude.payload).toMatchObject({
      toolCallId: "claude-call-1",
      data: { command: "vp test run" },
    });
    expect(openCode.payload).toMatchObject({
      toolCallId: "opencode-call-1",
      data: { command: "vp lint" },
    });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(200);
    expect(JSON.stringify(openCode.payload).length).toBeLessThan(200);
  });

  it("slims Codex-shaped mcp_tool_call items to rendered fields plus a result summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            id: "item-1",
            tool: "fetch_pr",
            server: "github",
            status: "completed",
            arguments: { pr: 42 },
            durationMs: 1200,
            result: {
              content: [{ type: "text", text: `PR body line one\n${"x".repeat(5000)}` }],
              structuredContent: { huge: "y".repeat(5000) },
            },
            _meta: { internal: true },
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const item = data.item as Record<string, unknown>;
    expect(item.tool).toBe("fetch_pr");
    expect(item.server).toBe("github");
    expect(item.arguments).toEqual({ pr: 42 });
    expect(item._meta).toBeUndefined();
    expect(item.result).toEqual({ content: "PR body line one" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("slims Claude-shaped mcp_tool_call data (toolName/input/result block)", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__github__fetch_pr",
          input: { pr: 42 },
          result: {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: `first line of output\n${"z".repeat(5000)}` }],
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.toolName).toBe("mcp__github__fetch_pr");
    expect(data.input).toEqual({ pr: 42 });
    expect(data.result).toEqual({ content: "first line of output" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("carries the spawned child's identity past the Codex-shaped result summary", () => {
    const spawnResult = JSON.stringify({
      threadId: "child-thread-1",
      title: "Fix PR #27 final provider review ledger",
      projectId: "project-1",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
      worktreePath: "/tmp/worktree",
    });
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            id: "item-1",
            tool: "spawn_session",
            server: "phoenix",
            status: "completed",
            arguments: { title: "Fix PR #27 final provider review ledger" },
            result: {
              content: [{ type: "text", text: spawnResult }],
              structuredContent: JSON.parse(spawnResult),
            },
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    // The summary alone truncates mid-JSON, so the id has to survive separately.
    expect((data.item as Record<string, unknown>).result).toEqual({
      content: `${spawnResult.slice(0, 83)}…`,
    });
    expect(data.spawnedSession).toEqual({
      title: "Fix PR #27 final provider review ledger",
      threadId: "child-thread-1",
      model: "claude-opus-5",
    });
  });

  it("carries the spawned child's identity past the Claude-shaped result summary", () => {
    const spawnResult = JSON.stringify({
      threadId: "child-thread-2",
      title: "Fix PR #27 final inbox retention ledger",
      modelSelection: { instanceId: "codex", model: "gpt-5.6-terra" },
    });
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__phoenix__spawn_session",
          input: { title: "Fix PR #27 final inbox retention ledger" },
          result: { type: "tool_result", tool_use_id: "toolu_1", content: spawnResult },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.spawnedSession).toEqual({
      title: "Fix PR #27 final inbox retention ledger",
      threadId: "child-thread-2",
      model: "gpt-5.6-terra",
    });
  });

  it("leaves an in-flight spawn without a child id (the row stays 'Spawning session')", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            tool: "spawn_session",
            server: "phoenix",
            status: "inProgress",
            arguments: { title: "Not started yet" },
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.spawnedSession).toBeUndefined();
  });

  it("passes task lifecycle payloads (no data field) through untouched", () => {
    const source = activity({
      taskId: "task-9",
      title: "Audit auth",
      role: "explorer",
      model: "opus",
      effort: "high",
      workflowName: "audit-flow",
      phases: [{ index: 0, title: "Audit" }],
      typedUsage: { totalTokens: 1200 },
      runHandles: { runId: "run-1", scriptPath: "/tmp/wf.js" },
      timelineBypass: true,
    });
    const projected = projectActivityPayload(source);
    expect(projected.payload).toEqual(source.payload);
  });
});

describe("Schedule write carrier survival", () => {
  const writeResult = {
    scheduleId: "schedule-1",
    projectId: "project-1",
    name: "Nightly audit",
    state: "enabled",
    timing: { type: "cron", expression: "0 6 * * 1-5" },
    timeZone: "Europe/London",
    cadence: "Weekdays at 06:00",
    nextOccurrenceAt: "2026-08-21T05:00:00.000Z",
    unacknowledgedFailure: false,
    updatedAt: "2026-08-20T09:00:00.000Z",
    upcomingOccurrences: [
      "2026-08-21T05:00:00.000Z",
      "2026-08-24T05:00:00.000Z",
      "2026-08-25T05:00:00.000Z",
      "2026-08-26T05:00:00.000Z",
      "2026-08-27T05:00:00.000Z",
    ],
    frequencyWarning: null,
  };

  const scheduleWrite = (tool: string, result: unknown) =>
    activity({
      itemType: "mcp_tool_call",
      data: { item: { type: "mcp_tool_call", server: "phoenix", tool, result } },
    });

  it("carries the card's fields past the result summary", () => {
    const projected = projectActivityPayload(scheduleWrite("create_schedule", writeResult));
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;

    // The full result does not survive — that is the whole reason the carrier
    // exists — but everything the card renders does.
    expect((data.item as Record<string, unknown>).result).not.toEqual(writeResult);
    expect(data.scheduleActivity).toEqual({
      action: "created",
      name: "Nightly audit",
      state: "enabled",
      timeZone: "Europe/London",
      cadence: "Weekdays at 06:00",
      nextOccurrenceAt: "2026-08-21T05:00:00.000Z",
    });
  });

  it("stays small: the five upcoming occurrences are for the agent, not the wire", () => {
    const projected = projectActivityPayload(scheduleWrite("create_schedule", writeResult));
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const carrier = data.scheduleActivity as Record<string, unknown>;

    expect(carrier.upcomingOccurrences).toBeUndefined();
    expect(Object.keys(carrier)).toHaveLength(6);
  });

  it("adds no carrier for a read, or for a write that failed", () => {
    const read = projectActivityPayload(scheduleWrite("list_schedules", writeResult));
    const failed = projectActivityPayload(
      scheduleWrite("create_schedule", { error: "name_conflict" }),
    );

    for (const projected of [read, failed]) {
      const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
      expect(data.scheduleActivity).toBeUndefined();
    }
  });
});

describe("list_session_providers carrier survival", () => {
  const providersResult = {
    providers: [
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        displayName: "Claude A",
        available: true,
        availability: {
          status: "limited",
          source: "claude_agent_sdk",
          windows: [
            { kind: "primary", label: "Session", usedPercent: 12 },
            { kind: "weekly", label: "Weekly", usedPercent: 100 },
          ],
        },
        models: [
          { id: "opus", displayName: "Opus", isDefault: true },
          { id: "sonnet", displayName: "Sonnet", isDefault: false },
        ],
      },
    ],
  };

  const listCall = (result: unknown) =>
    activity({
      itemType: "mcp_tool_call",
      data: {
        item: { type: "mcp_tool_call", server: "phoenix", tool: "list_session_providers", result },
      },
    });

  it("carries the snapshot fields past the result summary", () => {
    const projected = projectActivityPayload(listCall(providersResult));
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;

    expect((data.item as Record<string, unknown>).result).not.toEqual(providersResult);
    expect(data.providerListActivity).toEqual({
      totalCount: 1,
      providers: [
        {
          instanceId: "claudeAgent",
          displayName: "Claude A",
          driver: "claudeAgent",
          available: true,
          status: "limited",
          windows: [
            { kind: "primary", label: "Session", usedPercent: 12 },
            { kind: "weekly", label: "Weekly", usedPercent: 100 },
          ],
        },
      ],
    });
  });

  it("does not put the model catalog on the wire", () => {
    const projected = projectActivityPayload(listCall(providersResult));
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const carrier = data.providerListActivity as Record<string, unknown>;
    const first = (carrier.providers as Array<Record<string, unknown>>)[0];

    expect(first?.models).toBeUndefined();
    expect(JSON.stringify(projected.payload).includes("opus")).toBe(false);
  });

  it("carries an empty success so the card can show none configured", () => {
    const projected = projectActivityPayload(listCall({ providers: [] }));
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.providerListActivity).toEqual({ providers: [], totalCount: 0 });
  });

  it("adds no carrier for a failed call or a different tool", () => {
    const failed = projectActivityPayload(listCall({ error: "unavailable" }));
    const other = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcp_tool_call",
            server: "phoenix",
            tool: "spawn_session",
            result: providersResult,
          },
        },
      }),
    );

    for (const projected of [failed, other]) {
      const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
      expect(data.providerListActivity).toBeUndefined();
    }
  });
});
