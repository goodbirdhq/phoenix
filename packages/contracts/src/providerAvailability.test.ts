import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderAvailabilityResult } from "./providerAvailability.ts";

const decode = Schema.decodeUnknownSync(ProviderAvailabilityResult);

describe("ProviderAvailabilityResult", () => {
  it("keeps subscription windows on their configured provider instance", () => {
    const result = decode({
      providers: [
        {
          instanceId: "codex-personal",
          driver: "codex",
          displayName: "Personal",
          availability: {
            status: "available",
            source: "codex_app_server",
            observedAt: "2026-08-16T10:00:00.000Z",
            windows: [{ kind: "primary", usedPercent: 20, windowDurationMins: 300 }],
          },
        },
      ],
    });

    expect(result.providers[0]?.instanceId).toBe("codex-personal");
    expect(result.providers[0]?.availability.windows[0]?.usedPercent).toBe(20);
  });
});
