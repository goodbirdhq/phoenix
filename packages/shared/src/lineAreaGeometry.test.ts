import { describe, expect, it } from "vite-plus/test";
import { curvePath, niceScale, smoothCurve } from "./lineAreaGeometry.ts";

describe("monotone area geometry", () => {
  it("keeps curves within adjacent samples around sharp spikes", () => {
    const segments = smoothCurve([0, 10, 0, 1, 100, 5, 5, 0].map((y, x) => ({ x, y })));
    for (const { from, c1, c2, to } of segments) {
      for (let sample = 0; sample <= 100; sample++) {
        const t = sample / 100;
        const y =
          (1 - t) ** 3 * from.y +
          3 * (1 - t) ** 2 * t * c1.y +
          3 * (1 - t) * t ** 2 * c2.y +
          t ** 3 * to.y;
        expect(y).toBeGreaterThanOrEqual(Math.min(from.y, to.y) - 1e-8);
        expect(y).toBeLessThanOrEqual(Math.max(from.y, to.y) + 1e-8);
      }
    }
  });
  it("does not fabricate a curve for empty or single-sample periods", () => {
    expect(curvePath(smoothCurve([]))).toBe("");
    expect(curvePath(smoothCurve([{ x: 0, y: 12 }]))).toBe("");
  });
});

describe("niceScale", () => {
  it("never puts the peak above the top of the scale", () => {
    // Regression: an earlier version stopped at the last step below the peak,
    // so the tallest day was drawn past the plot and clipped.
    for (const peak of [1122.71, 999, 1, 0.04, 1_400_000_000, 37.5, 5000, 100.001]) {
      const { max } = niceScale(peak, 4);
      expect(max, `peak ${peak}`).toBeGreaterThanOrEqual(peak);
    }
  });

  it("starts at zero and ends at the maximum", () => {
    const { max, ticks } = niceScale(1122.71, 4);

    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeCloseTo(max, 6);
  });

  it("uses evenly spaced 1/2/5 steps", () => {
    const { ticks } = niceScale(1122.71, 4);
    const steps = ticks.slice(1).map((tick, index) => tick - (ticks[index] ?? 0));

    for (const step of steps) expect(step).toBeCloseTo(steps[0] ?? 0, 6);
    const [first = 0] = steps;
    const normalized = first / 10 ** Math.floor(Math.log10(first));
    expect([1, 2, 5, 10]).toContain(Math.round(normalized));
  });

  it("keeps the tick count near the requested resolution", () => {
    const { ticks } = niceScale(1122.71, 4);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(7);
  });

  it("degrades to a single zero tick with no data", () => {
    expect(niceScale(0, 4)).toEqual({ max: 0, ticks: [0] });
  });
});
