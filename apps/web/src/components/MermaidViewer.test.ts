import { describe, expect, it, vi } from "vite-plus/test";

const initialize = vi.hoisted(() => vi.fn());
const render = vi.hoisted(() => vi.fn());
vi.mock("mermaid", () => ({ default: { initialize, render } }));

import { renderMermaid } from "./MermaidViewer";

describe("on-demand Mermaid rendering", () => {
  it("rejects oversized UTF-8 source before invoking Mermaid", async () => {
    initialize.mockClear();
    render.mockClear();
    await expect(renderMermaid("é".repeat(65_537), "light")).rejects.toThrow("128 KiB");
    expect(initialize).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it("passes malformed source verbatim and reports the renderer error", async () => {
    render.mockReset().mockRejectedValueOnce(new Error("Syntax error"));
    const source = "sequenceDiagram\nAlice->>Bob: prose; semicolon";
    await expect(renderMermaid(source, "dark")).rejects.toThrow("Syntax error");
    expect(render).toHaveBeenCalledWith(expect.any(String), source);
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        securityLevel: "strict",
        htmlLabels: false,
        maxTextSize: 131072,
        maxEdges: 500,
        theme: "dark",
      }),
    );
  });
});
