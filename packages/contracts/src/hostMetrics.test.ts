import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  HOST_METRICS_MAX_SAMPLE_INTERVAL_MS,
  HOST_METRICS_MIN_SAMPLE_INTERVAL_MS,
  HostMetricsSubscriptionInput,
} from "./hostMetrics.ts";

describe("HostMetricsSubscriptionInput", () => {
  const isInput = Schema.is(HostMetricsSubscriptionInput);

  it("accepts supported sample intervals", () => {
    expect(isInput({ sampleIntervalMs: HOST_METRICS_MIN_SAMPLE_INTERVAL_MS })).toBe(true);
    expect(isInput({ sampleIntervalMs: HOST_METRICS_MAX_SAMPLE_INTERVAL_MS })).toBe(true);
  });

  it("rejects abusive or unsupported sample intervals", () => {
    expect(isInput({ sampleIntervalMs: HOST_METRICS_MIN_SAMPLE_INTERVAL_MS - 1 })).toBe(false);
    expect(isInput({ sampleIntervalMs: HOST_METRICS_MAX_SAMPLE_INTERVAL_MS + 1 })).toBe(false);
  });
});
