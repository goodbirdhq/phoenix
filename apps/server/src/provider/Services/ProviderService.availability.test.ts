/**
 * `containedAvailability` is what keeps a whole availability fan-out — the
 * Usage page's, and `list_session_providers`' — answering for the instances
 * that work when one of them does not.
 */
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { describe, expect } from "vite-plus/test";

import { ProviderAdapterRequestError } from "../Errors.ts";
import { containedAvailability, unknownAvailabilityForDriver } from "./ProviderService.ts";

const instanceId = ProviderInstanceId.make("claude-work");
const claudeAgent = ProviderDriverKind.make("claudeAgent");
const target = { instanceId, provider: claudeAgent } as const;

describe("containedAvailability", () => {
  it.effect("passes a real reading straight through", () =>
    Effect.gen(function* () {
      const reading = {
        status: "available",
        source: "claude_cli_usage",
        windows: [{ kind: "session", usedPercent: 5 }],
      } as const;
      expect(yield* containedAvailability(target, () => Effect.succeed(reading))).toBe(reading);
    }),
  );

  it.effect("answers unknown for an adapter that failed", () =>
    Effect.gen(function* () {
      expect(
        yield* containedAvailability(target, () =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: String(claudeAgent),
              method: "refreshAvailability",
              detail: "usage probe failed",
            }),
          ),
        ),
      ).toEqual(unknownAvailabilityForDriver(claudeAgent));
    }),
  );

  it.effect("answers unknown for an adapter that threw", () =>
    Effect.gen(function* () {
      // A defect bypasses typed-error handling entirely; uncontained it would
      // fail the caller's whole fan-out over one misbehaving instance.
      expect(
        yield* containedAvailability(target, () =>
          Effect.sync((): never => {
            throw new Error("spawn blew up");
          }),
        ),
      ).toEqual(unknownAvailabilityForDriver(claudeAgent));
    }),
  );

  it.effect("still stops when the caller goes away", () =>
    Effect.gen(function* () {
      const exit = yield* containedAvailability(target, () => Effect.interrupt).pipe(Effect.exit);
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    }),
  );

  it("names the channel a silent driver is silent on", () => {
    expect(unknownAvailabilityForDriver(claudeAgent).source).toBe("claude_agent_sdk");
    expect(unknownAvailabilityForDriver(ProviderDriverKind.make("codex")).source).toBe(
      "codex_app_server",
    );
    expect(unknownAvailabilityForDriver(ProviderDriverKind.make("opencode")).source).toBe(
      "unsupported",
    );
  });
});

describe("containedAvailability while resolving the reading", () => {
  it.effect("contains a failure that happens before the effect is even built", () =>
    Effect.gen(function* () {
      // Deciding *which* reading to take (is this instance refreshable? is the
      // service present?) is inside the containment too.
      expect(
        yield* containedAvailability(target, (): Effect.Effect<never> => {
          throw new Error("could not decide how to read this instance");
        }),
      ).toEqual(unknownAvailabilityForDriver(claudeAgent));
    }),
  );
});
