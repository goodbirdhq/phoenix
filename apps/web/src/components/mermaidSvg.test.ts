import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { sanitizeMermaidSvg } from "./mermaidSvg";

vi.stubGlobal("DOMParser", DOMParser);
vi.stubGlobal("XMLSerializer", XMLSerializer);
afterEach(() => vi.unstubAllGlobals());

describe("Mermaid SVG boundary", () => {
  it("removes navigation, executable content, and external resources while preserving labels", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" onload="alert(1)"><style>@import url(https://example.com/a.css)</style><a href="https://example.com" onclick="alert(1)"><text x="1">Safe label</text><script>alert(1)</script></a><image href="https://example.com/a.png"/><g style="fill:url(https://example.com/x)"><path d="M0 0 L1 1" marker-end="url(#arrow)"/></g><script>alert(1)</script></svg>`;
    const result = sanitizeMermaidSvg(svg);
    expect(result).toContain("Safe label");
    expect(result).toContain('marker-end="url(#arrow)"');
    expect(result).not.toMatch(/<a\b|<image\b|<script\b|<style\b|onload|onclick|https:\/\//);
  });
});
