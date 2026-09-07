import { describe, expect, it } from "vite-plus/test";
import { footerShowsLabels } from "./navigation-footer-layout";
describe("navigation footer label fit", () => {
  it("keeps six accessible icon targets below the agreed breakpoint", () => {
    expect(footerShowsLabels(390, 1)).toBe(false);
    expect(footerShowsLabels(409, 1)).toBe(false);
    expect(footerShowsLabels(410, 1)).toBe(true);
    expect(footerShowsLabels(412, 1)).toBe(true);
  });
  it("falls back to icons when larger text no longer fits the longest destination", () => {
    expect(footerShowsLabels(412, 1.3)).toBe(false);
    expect(footerShowsLabels(500, 1.3)).toBe(true);
  });
});
