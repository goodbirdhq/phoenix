import {
  type EnvironmentId,
  McpCapabilityUnavailableError,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  ScheduleOrchestrationDeniedError,
  SessionOrchestrationDeniedError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability = "preview" | "sessions" | "schedules" | "device" | "pull-requests";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

/** The error a missing capability surfaces as; preview keeps its own so the broker can route it. */
export type McpCapabilityError<C extends McpCapability> = C extends "preview"
  ? PreviewAutomationUnavailableError
  : McpCapabilityUnavailableError;

const missingCapability = (
  invocation: McpInvocationScope,
  capability: McpCapability,
): PreviewAutomationUnavailableError | McpCapabilityUnavailableError => {
  const fields = {
    environmentId: invocation.environmentId,
    threadId: invocation.threadId,
    providerSessionId: invocation.providerSessionId,
    providerInstanceId: invocation.providerInstanceId,
  };
  return capability === "preview"
    ? new PreviewAutomationUnavailableError({ capability, ...fields })
    : new McpCapabilityUnavailableError({ capability, ...fields });
};

// The preview-shaped unavailable error only speaks for the preview
// capability; sessions/schedules tools use their own dedicated requires below
// for domain-specific error types.
export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  Effect.flatMap(McpInvocationContext, (invocation) =>
    invocation.capabilities.has(capability)
      ? Effect.succeed(invocation)
      : // The conditional type narrows what the literal argument decided at runtime.
        Effect.fail(missingCapability(invocation, capability) as McpCapabilityError<C>),
  ).pipe(Effect.withSpan("mcp.requireCapability"));

export const requireMcpSessionsCapability = Effect.fn("mcp.requireSessionsCapability")(
  function* () {
    const invocation = yield* McpInvocationContext;
    if (!invocation.capabilities.has("sessions")) {
      return yield* new SessionOrchestrationDeniedError({
        reason: "capability_unavailable",
        message: "This session's MCP credential does not carry the sessions capability.",
      });
    }
    return invocation;
  },
);

export const requireMcpSchedulesCapability = Effect.fn("mcp.requireSchedulesCapability")(
  function* () {
    const invocation = yield* McpInvocationContext;
    if (!invocation.capabilities.has("schedules")) {
      return yield* new ScheduleOrchestrationDeniedError({
        reason: "capability_unavailable",
        message: "This session's MCP credential does not carry the schedules capability.",
      });
    }
    return invocation;
  },
);
