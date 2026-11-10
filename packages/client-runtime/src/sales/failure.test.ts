import type { SalesActionFailureReason, SalesFailureOrigin } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { approveRequestFailure, type SalesFailure } from "./failure.ts";

const salesFailure = (
  cause: {
    readonly origin: SalesFailureOrigin | null;
    readonly reason: SalesActionFailureReason | null;
  },
  description: string,
): SalesFailure => ({
  ...cause,
  title: "Failed",
  description,
  reread: false,
  currentHash: null,
  state: null,
});

describe("approveRequestFailure", () => {
  it("says nothing was approved only when Phoenix or the engine refused the request", () => {
    for (const failure of [
      { origin: "engine", reason: "unauthorised" },
      { origin: "engine", reason: "bad_request" },
      { origin: "phoenix", reason: "not-configured" },
      { origin: "phoenix", reason: "failed" },
    ] as const) {
      expect(approveRequestFailure(salesFailure(failure, "Refused."))).toEqual({
        unknown: false,
        text: "Refused.",
      });
    }
  });

  it("calls the outcome unknown whenever the request may have landed", () => {
    for (const failure of [
      { origin: "transport", reason: "unreachable" },
      { origin: "transport", reason: "failed" },
      { origin: "engine", reason: "budget" },
      { origin: "engine", reason: "other" },
      { origin: null, reason: null },
    ] as const) {
      expect(approveRequestFailure(salesFailure(failure, "Timed out.")).unknown).toBe(true);
    }
  });
});
