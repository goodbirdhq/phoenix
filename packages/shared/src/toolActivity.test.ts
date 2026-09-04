import { describe, expect, it } from "vite-plus/test";

import {
  deriveSessionMessageToolActivity,
  deriveSpawnedSessionToolActivity,
  deriveToolActivityPresentation,
} from "./toolActivity.ts";

describe("toolActivity", () => {
  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it("recognizes a Claude-style Phoenix session spawn before and after its result", () => {
    const input = {
      toolName: "mcp__phoenix__spawn_session",
      input: { title: "Audit the renderer", model: "claude-opus-5", prompt: "Do the work" },
    };
    expect(deriveSpawnedSessionToolActivity(input)).toEqual({
      title: "Audit the renderer",
      model: "claude-opus-5",
    });

    expect(
      deriveSpawnedSessionToolActivity({
        ...input,
        result: {
          type: "text",
          content: JSON.stringify({
            threadId: "child-thread",
            title: "Audit the renderer",
            modelSelection: { model: "claude-opus-5" },
          }),
        },
      }),
    ).toEqual({
      title: "Audit the renderer",
      threadId: "child-thread",
      model: "claude-opus-5",
    });
  });

  it("recognizes a Codex-style session spawn with structured MCP content", () => {
    expect(
      deriveSpawnedSessionToolActivity({
        item: {
          type: "mcpToolCall",
          server: "phoenix",
          tool: "spawn_session",
          arguments: { title: "Check mobile" },
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ threadId: "child-thread", title: "Check mobile" }),
              },
            ],
          },
        },
      }),
    ).toEqual({
      title: "Check mobile",
      threadId: "child-thread",
    });
  });

  it("prefers the identity the server carried past its own result slimming", () => {
    // What a client actually receives: the result is summarized to one
    // truncated line, so only `spawnedSession` still holds the child's id.
    expect(
      deriveSpawnedSessionToolActivity({
        item: {
          type: "mcpToolCall",
          server: "phoenix",
          tool: "spawn_session",
          arguments: { title: "Check mobile", model: "gpt-5.6-terra" },
          result: { content: '{"threadId":"child-thr…' },
        },
        spawnedSession: {
          title: "Check mobile",
          threadId: "child-thread",
          model: "claude-opus-5",
        },
      }),
    ).toEqual({
      title: "Check mobile",
      threadId: "child-thread",
      model: "claude-opus-5",
    });
  });

  it("does not classify unrelated MCP tools as session spawns", () => {
    expect(
      deriveSpawnedSessionToolActivity({
        toolName: "mcp__phoenix__read_session",
        input: { title: "Not a spawn" },
      }),
    ).toBeUndefined();
    expect(
      deriveSpawnedSessionToolActivity({
        toolName: "mcp__third_party__spawn_session",
        input: { title: "Not a Phoenix session" },
      }),
    ).toBeUndefined();
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });
  });

  it("drops duplicated generic read-file detail when no path is available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });
});

describe("deriveSessionMessageToolActivity", () => {
  it("recognizes a downward send with the target in the arguments", () => {
    expect(
      deriveSessionMessageToolActivity({
        item: {
          type: "mcpToolCall",
          server: "phoenix",
          tool: "send_to_session",
          arguments: {
            threadId: "child-thread",
            message: "Focus on the retention ledger first.\nThen the inbox.",
          },
        },
      }),
    ).toEqual({
      direction: "to-child",
      threadId: "child-thread",
      preview: "Focus on the retention ledger first.",
    });
  });

  it("recognizes an upward send, taking the parent id from the result", () => {
    const input = {
      toolName: "mcp__phoenix__send_to_parent",
      input: { message: "Which SHA is master?", awaitingReply: true },
    };
    // In flight: no target yet, but the direction and preview already render.
    expect(deriveSessionMessageToolActivity(input)).toEqual({
      direction: "to-parent",
      preview: "Which SHA is master?",
      awaitingReply: true,
    });
    expect(
      deriveSessionMessageToolActivity({
        ...input,
        result: {
          type: "tool_result",
          content: JSON.stringify({
            parentThreadId: "parent-thread",
            delivery: "queued",
            awaitingReply: true,
          }),
        },
      }),
    ).toEqual({
      direction: "to-parent",
      threadId: "parent-thread",
      preview: "Which SHA is master?",
      awaitingReply: true,
    });
  });

  it("prefers the server-side sessionMessage carry over raw payload fields", () => {
    expect(
      deriveSessionMessageToolActivity({
        toolName: "mcp__phoenix__send_to_parent",
        input: { message: "raw message" },
        sessionMessage: {
          direction: "to-parent",
          threadId: "parent-thread",
          preview: "carried preview",
          awaitingReply: false,
        },
      }),
    ).toEqual({
      direction: "to-parent",
      threadId: "parent-thread",
      preview: "carried preview",
      awaitingReply: false,
    });
  });

  it("truncates the preview to one row-sized line", () => {
    const derived = deriveSessionMessageToolActivity({
      toolName: "mcp__phoenix__send_to_session",
      input: { threadId: "child-thread", message: "x".repeat(200) },
    });
    expect(derived?.preview).toHaveLength(84);
    expect(derived?.preview?.endsWith("…")).toBe(true);
  });

  it("ignores every other MCP tool", () => {
    expect(
      deriveSessionMessageToolActivity({
        toolName: "mcp__phoenix__spawn_session",
        input: { message: "not a message tool" },
      }),
    ).toBeUndefined();
  });
});
