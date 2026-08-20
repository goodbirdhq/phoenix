import {
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  ScheduleOrchestrationDeniedError,
  SessionOrchestrationDeniedError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability = "preview" | "sessions" | "schedules";

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

// The preview-shaped unavailable error only speaks for the preview
// capability; sessions tools use requireMcpSessionsCapability below.
export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: Extract<McpCapability, "preview">,
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});

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
