import { describe, expect, it } from "vite-plus/test";

import { safeHttpsUrl } from "./links.ts";

describe("safeHttpsUrl", () => {
  it("keeps a well-formed https URL", () => {
    expect(safeHttpsUrl("https://www.notion.so/abc123")).toBe("https://www.notion.so/abc123");
  });

  it("refuses every other scheme, and text that is not a URL", () => {
    for (const value of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://www.notion.so/abc123",
      "https://",
      "https://exa mple.com/[",
      " https://www.notion.so/abc123",
      "www.notion.so/abc123",
      "",
      null,
    ]) {
      expect(safeHttpsUrl(value)).toBeNull();
    }
  });
});
