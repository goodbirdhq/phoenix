import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  PROVIDER_AVAILABILITY_CONTRACT_VERSION,
  ProviderAvailabilityResult,
  narrowProviderAvailability,
  type ProviderAvailability,
} from "./providerAvailability.ts";
import { canRefreshProviderAvailability, type ServerProvider } from "./server.ts";

const decode = Schema.decodeUnknownSync(ProviderAvailabilityResult);

/**
 * The availability schema as an already-deployed (version 1) client compiled
 * it: window kinds were a closed pair and `claude_cli_usage` did not exist.
 * Decoding through this is the only honest test of what such a client does
 * with a response from a newer server — it cannot be asked to run new code.
 */
const V1_ProviderAvailability = Schema.Struct({
  status: Schema.Literals(["available", "limited", "unknown"]),
  source: Schema.Literals(["codex_app_server", "claude_agent_sdk", "unsupported"]),
  observedAt: Schema.optional(Schema.String),
  windows: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["primary", "secondary"]),
      usedPercent: Schema.Number,
      resetsAt: Schema.optional(Schema.String),
      windowDurationMins: Schema.optional(Schema.Number),
    }),
  ),
});
const V1_ProviderAvailabilityResult = Schema.Struct({
  providers: Schema.Array(
    Schema.Struct({
      instanceId: Schema.String,
      driver: Schema.String,
      displayName: Schema.optional(Schema.String),
      availability: V1_ProviderAvailability,
    }),
  ),
});
const decodeAsDeployedV1Client = Schema.decodeUnknownSync(V1_ProviderAvailabilityResult);

/** The request schema an already-deployed server decodes with. */
const V1_ProviderAvailabilityInput = Schema.Struct({ instanceId: Schema.optional(Schema.String) });
const decodeRequestAsDeployedV1Server = Schema.decodeUnknownSync(V1_ProviderAvailabilityInput);

const claudeCliAvailability = {
  status: "available",
  source: "claude_cli_usage",
  observedAt: "2026-08-17T20:45:00.000Z",
  account: {
    id: "claude:org-1:maintainer@example.com",
    verification: "native_verified",
    displayName: "maintainer@example.com",
  },
  stale: { reason: "refresh_failed", attemptedAt: "2026-08-17T20:51:00.000Z" },
  windows: [
    { kind: "session", label: "Current session", usedPercent: 5 },
    { kind: "model-weekly", label: "Fable", scope: "fable", usedPercent: 100 },
  ],
} satisfies ProviderAvailability;

const codexAvailability = {
  status: "limited",
  source: "codex_app_server",
  observedAt: "2026-08-17T20:45:00.000Z",
  windows: [
    { kind: "primary", usedPercent: 40, windowDurationMins: 300 },
    { kind: "secondary", usedPercent: 100, windowDurationMins: 10_080 },
  ],
} satisfies ProviderAvailability;

const claudeProvider = (overrides?: Partial<ServerProvider>): ServerProvider =>
  ({
    instanceId: "claude-work",
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    version: "2.1.233",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-17T20:45:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    availabilityRefreshSupported: true,
    ...overrides,
  }) as ServerProvider;

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

  it("carries Claude's named weekly pools and its verified account", () => {
    const result = decode({
      providers: [
        {
          instanceId: "claude-work",
          driver: "claudeAgent",
          availability: {
            status: "available",
            source: "claude_cli_usage",
            observedAt: "2026-08-17T20:45:00.000Z",
            account: {
              id: "claude:org-1:maintainer@example.com",
              verification: "native_verified",
              displayName: "maintainer@example.com",
            },
            windows: [
              { kind: "session", label: "Current session", usedPercent: 5 },
              { kind: "model-weekly", label: "Fable", scope: "fable", usedPercent: 72 },
            ],
          },
        },
      ],
    });

    expect(result.providers[0]?.availability.account?.verification).toBe("native_verified");
    expect(result.providers[0]?.availability.windows.map((window) => window.scope)).toEqual([
      undefined,
      "fable",
    ]);
  });

  it("drops an unreadable window or instance instead of blanking the page", () => {
    const result = decode({
      providers: [
        {
          instanceId: "claude-work",
          driver: "claudeAgent",
          availability: {
            status: "available",
            source: "claude_cli_usage",
            windows: [
              { kind: "session", usedPercent: 5 },
              { kind: "weekly", usedPercent: 420 },
            ],
          },
        },
        { instanceId: "broken", driver: "claudeAgent" },
      ],
    });

    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]?.availability.windows).toEqual([
      { kind: "session", usedPercent: 5 },
    ]);
  });
});

describe("narrowProviderAvailability", () => {
  it("hands a current caller the reading unchanged", () => {
    expect(
      narrowProviderAvailability(claudeCliAvailability, PROVIDER_AVAILABILITY_CONTRACT_VERSION),
    ).toBe(claudeCliAvailability);
    expect(narrowProviderAvailability(codexAvailability, undefined)).toBe(codexAvailability);
  });

  it("keeps every window an already-deployed client already understood", () => {
    // Codex's primary/secondary pair is version 1 vocabulary, so nothing about
    // its card changes for a client that predates this contract.
    expect(narrowProviderAvailability(codexAvailability, 1)).toBe(codexAvailability);
  });

  it("says nothing rather than something an older client cannot decode", () => {
    const narrowed = narrowProviderAvailability(claudeCliAvailability, 1);
    expect(narrowed.source).toBe("claude_agent_sdk");
    expect(narrowed.windows).toEqual([]);
    // The status summarised rows that are no longer being sent.
    expect(narrowed.status).toBe("unknown");
    // Optional keys added since version 1 stay: struct decoding ignores what it
    // does not know, so removing them would only cost newer readers.
    expect(narrowed.account).toEqual(claudeCliAvailability.account);
    expect(narrowed.observedAt).toBe(claudeCliAvailability.observedAt);
  });

  it("re-derives status from the windows that survive a partial narrowing", () => {
    const mixed = {
      status: "limited",
      source: "codex_app_server",
      windows: [
        { kind: "primary", usedPercent: 10 },
        // A pool an older client has no literal for, and the only one at 100%.
        { kind: "model-weekly", scope: "fable", usedPercent: 100 },
      ],
    } satisfies ProviderAvailability;
    const narrowed = narrowProviderAvailability(mixed, 1);
    expect(narrowed.windows).toEqual([{ kind: "primary", usedPercent: 10 }]);
    // Claiming "limited" while sending only a 10% window would be a lie.
    expect(narrowed.status).toBe("available");
  });

  it("stays readable by a server that predates the version field", () => {
    // Declaring the version has to be safe in the other direction too: a
    // current client talking to an older server must not have its request
    // rejected for a field that server has never heard of.
    expect(
      decodeRequestAsDeployedV1Server({
        instanceId: "claude-work",
        refresh: true,
        contractVersion: PROVIDER_AVAILABILITY_CONTRACT_VERSION,
      }),
    ).toEqual({ instanceId: "claude-work" });
  });

  it("keeps an already-deployed client's Usage page readable end to end", () => {
    const wire = {
      providers: [
        { instanceId: "codex-personal", driver: "codex", availability: codexAvailability },
        { instanceId: "claude-work", driver: "claudeAgent", availability: claudeCliAvailability },
      ],
    };
    // Unnarrowed, a version 1 client fails the whole response and loses the
    // Codex card it could have rendered perfectly well.
    expect(() => decodeAsDeployedV1Client(wire)).toThrow();

    const narrowed = {
      providers: wire.providers.map((provider) => ({
        ...provider,
        availability: narrowProviderAvailability(provider.availability, 1),
      })),
    };
    const decoded = decodeAsDeployedV1Client(narrowed);
    expect(decoded.providers).toHaveLength(2);
    expect(decoded.providers[0]?.availability.windows).toHaveLength(2);
    expect(decoded.providers[1]?.availability.status).toBe("unknown");
    // ...and a current client still reads the same payload.
    expect(decode(wire).providers).toHaveLength(2);
  });
});

describe("canRefreshProviderAvailability", () => {
  it("allows a refresh only for an installed, enabled, signed-in instance", () => {
    expect(canRefreshProviderAvailability(claudeProvider())).toBe(true);
    expect(canRefreshProviderAvailability(claudeProvider({ enabled: false }))).toBe(false);
    expect(canRefreshProviderAvailability(claudeProvider({ installed: false }))).toBe(false);
    expect(
      canRefreshProviderAvailability(claudeProvider({ auth: { status: "unauthenticated" } })),
    ).toBe(false);
    expect(canRefreshProviderAvailability(claudeProvider({ auth: { status: "unknown" } }))).toBe(
      false,
    );
    expect(canRefreshProviderAvailability(claudeProvider({ availability: "unavailable" }))).toBe(
      false,
    );
    expect(
      canRefreshProviderAvailability(claudeProvider({ availabilityRefreshSupported: false })),
    ).toBe(false);
    expect(
      canRefreshProviderAvailability(
        claudeProvider({ availabilityRefreshSupported: undefined }) as ServerProvider,
      ),
    ).toBe(false);
  });
});
