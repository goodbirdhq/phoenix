import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { canViewMermaid } from "../../../modules/t3-markdown-text/src/mermaidCodeBlock";
import { parseViewerMessage, shouldShowViewerSource } from "./viewerState";

describe("Android Mermaid code blocks", () => {
  it("offers the action only for a completed Mermaid fence on Android", () => {
    expect(canViewMermaid("android", "mermaid", true)).toBe(true);
    expect(canViewMermaid("android", "Mermaid", true)).toBe(true);
    expect(canViewMermaid("android", "mermaid", false)).toBe(false);
    expect(canViewMermaid("android", "typescript", true)).toBe(false);
    expect(canViewMermaid("ios", "mermaid", true)).toBe(false);
  });

  it("ships a local bundle with a restrictive policy and no remote script", () => {
    const html: string = JSON.parse(
      readFileSync(new URL("./viewerAsset.json", import.meta.url), "utf8"),
    );
    const shell = html.slice(0, html.indexOf("<script>"));
    expect(shell).toContain("Content-Security-Policy");
    expect(shell).toContain("connect-src 'none'");
    expect(shell).toContain("script-src 'sha256-");
    expect(shell).not.toMatch(/<script[^>]+src=/i);
    expect(shell).not.toMatch(/<iframe/i);
    expect(html).toContain("securityLevel");
    expect(html).toContain("maxEdges");
  });

  it("keeps source visible after a render error and accepts a later success", () => {
    const result = parseViewerMessage(JSON.stringify({ type: "error", error: "Syntax error" }));
    expect(result).toEqual({ type: "error", error: "Syntax error" });
    expect(shouldShowViewerSource(false, result?.type === "error" ? result.error : null)).toBe(
      true,
    );
    expect(parseViewerMessage('{"type":"rendered"}')).toEqual({ type: "rendered" });
    expect(shouldShowViewerSource(false, null)).toBe(false);
    expect(shouldShowViewerSource(true, null)).toBe(true);
    expect(parseViewerMessage("not json")).toBeNull();
  });
});
