import { describe, expect, it } from "vite-plus/test";

import {
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
