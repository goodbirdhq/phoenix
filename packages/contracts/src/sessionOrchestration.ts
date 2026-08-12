import { Schema } from "effect";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderOptionDescriptor, ProviderOptionSelection } from "./model.ts";
import {
  ModelSelection,
  OrchestrationSessionStatus,
  ProviderInteractionMode,
  RuntimeMode,
  SessionReport,
  SessionReportArtifact,
  SessionReportFinding,
  SessionReportStatus,
  SessionReportValidation,
  structuredReportFieldsWithinSizeCap,
  SessionStopReason,
  SessionStoppedBy,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Contracts for the `sessions` MCP toolkit: tools a running agent session
 * uses to spawn sibling T3 threads, exchange messages with them, and post a
 * completion report back to whoever spawned it.
 */

// How many live children one thread may spawn, and how deep spawn chains may
// nest. Both caps exist to stop a runaway agent from fork-bombing the
// machine with provider processes.
export const SESSION_SPAWN_MAX_CHILDREN = 8;
export const SESSION_SPAWN_MAX_DEPTH = 3;

const BoundedText = (maxLength: number) => Schema.String.check(Schema.isMaxLength(maxLength));

export const SpawnSessionInput = Schema.Struct({
  // Provider instance slug from list_session_providers (e.g. "claudeAgent",
  // "codex_personal"). Omit to reuse the calling thread's provider instance.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  // Model id from list_session_providers. Omit for the provider's default.
  model: Schema.optional(TrimmedNonEmptyString),
  // Provider option selections for the chosen model, e.g.
  // [{ "id": "reasoningEffort", "value": "high" }]. Valid ids and choice
  // values come from the model's options in list_session_providers.
  options: Schema.optional(Schema.Array(ProviderOptionSelection)),
  // First user message the spawned session starts working on.
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(65_536)),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  // Defaults to the calling thread's project.
  projectId: Schema.optional(ProjectId),
  // "worktree" (default) gives the child its own git worktree so parallel
  // agents do not trample one working tree; "project-root" shares the
  // project's root working tree.
  isolation: Schema.optional(Schema.Literals(["worktree", "project-root"])),
  // Revision to use as the starting point for the spawned worktree. If it is
  // not present locally, Phoenix fetches origin before resolving it.
  gitRef: Schema.optional(TrimmedNonEmptyString),
  // Base ref for the spawned branch's merge-base metadata. When gitRef and
  // checkoutPr are omitted, this is also the revision checked out. Defaults
  // to the current project branch.
  baseRef: Schema.optional(TrimmedNonEmptyString),
  // Name the spawned worktree branch explicitly instead of using a temporary
  // branch name.
  branchName: Schema.optional(TrimmedNonEmptyString),
  // Fetch origin's pull-request head and create the worktree at that commit.
  // This cannot be combined with gitRef.
  checkoutPr: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  // Permission mode for the child. Never allowed to exceed the calling
  // thread's own mode.
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type SpawnSessionInput = typeof SpawnSessionInput.Type;

export const SpawnSessionResult = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  sha: Schema.NullOr(TrimmedNonEmptyString),
  dirty: Schema.NullOr(Schema.Boolean),
});
export type SpawnSessionResult = typeof SpawnSessionResult.Type;

export const SessionProviderModel = Schema.Struct({
  id: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  isDefault: Schema.Boolean,
  // Tunable options this model accepts (reasoning effort, context size, …),
  // each with its valid choices. Selections go in spawn_session `options`.
  options: Schema.optional(Schema.Array(ProviderOptionDescriptor)),
});

export const SessionProviderDescriptor = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  available: Schema.Boolean,
  models: Schema.Array(SessionProviderModel),
});
export type SessionProviderDescriptor = typeof SessionProviderDescriptor.Type;

// A bare empty struct encodes to a typeless `anyOf` JSON schema, which some
// MCP clients (Claude Code) reject hard enough to drop the whole server's
// tools. Keep at least one optional field so the schema stays `type: object`.
export const ListSessionProvidersInput = Schema.Struct({
  // When true, omit providers that are not currently available.
  onlyAvailable: Schema.optional(Schema.Boolean),
});
export type ListSessionProvidersInput = typeof ListSessionProvidersInput.Type;

export const ListSessionProvidersResult = Schema.Struct({
  providers: Schema.Array(SessionProviderDescriptor),
});
export type ListSessionProvidersResult = typeof ListSessionProvidersResult.Type;

export const SendToSessionInput = Schema.Struct({
  threadId: ThreadId,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(65_536)),
  mode: Schema.optional(Schema.Literals(["queue", "interrupt"])),
});
export type SendToSessionInput = typeof SendToSessionInput.Type;

export const SendToSessionResult = Schema.Struct({
  threadId: ThreadId,
  delivery: Schema.Literals(["immediate", "queued", "unknown"]),
});
export type SendToSessionResult = typeof SendToSessionResult.Type;

export const ReadSessionInput = Schema.Struct({
  threadId: ThreadId,
  // How many trailing messages to include. 0 returns status only.
  messageLimit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(20)),
  ),
});
export type ReadSessionInput = typeof ReadSessionInput.Type;

export const ReadSessionMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: BoundedText(16_384),
  createdAt: IsoDateTime,
});

export const ReadSessionResult = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  sessionStatus: Schema.NullOr(OrchestrationSessionStatus),
  settled: Schema.Boolean,
  report: Schema.NullOr(SessionReport),
  stoppedBy: Schema.NullOr(SessionStoppedBy),
  stopRequestedAt: Schema.NullOr(IsoDateTime),
  stopReason: Schema.NullOr(SessionStopReason),
  interruptedToolCall: Schema.Boolean,
  lastCompletedOperation: Schema.NullOr(TrimmedNonEmptyString),
  messages: Schema.Array(ReadSessionMessage),
  // Present when the spawned session has a git worktree. branch and dirty use
  // cached status; sha is resolved live so callers can verify the revision.
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  sha: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  dirty: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type ReadSessionResult = typeof ReadSessionResult.Type;

export const StopSessionInput = Schema.Struct({
  threadId: ThreadId,
  // When supplied, keep the child alive long enough to receive a stop notice
  // and post a partial report before the deadline forces a hard stop.
  gracePeriodMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(120_000)),
  ),
  requestPartialReport: Schema.optional(Schema.Boolean),
});
export type StopSessionInput = typeof StopSessionInput.Type;

export const StopSessionResult = Schema.Struct({
  threadId: ThreadId,
  status: Schema.Literal("stop-requested"),
});
export type StopSessionResult = typeof StopSessionResult.Type;

export const PostReportInput = Schema.Struct({
  status: SessionReportStatus,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  summary: BoundedText(16_384),
  artifacts: Schema.optional(Schema.Array(SessionReportArtifact)),
  // Optional machine-readable fields alongside the markdown summary.
  findings: Schema.optional(Schema.Array(SessionReportFinding).check(Schema.isMaxLength(100))),
  validation: Schema.optional(SessionReportValidation),
  recommendation: Schema.optional(Schema.String.check(Schema.isMaxLength(1_024))),
  // 0-100. How much of the assigned work this report represents.
  completionPercent: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(100)),
  ),
}).check(structuredReportFieldsWithinSizeCap);
export type PostReportInput = typeof PostReportInput.Type;

const SessionOrchestrationErrorFields = {
  message: Schema.String,
};

export class SessionOrchestrationDeniedError extends Schema.TaggedErrorClass<SessionOrchestrationDeniedError>()(
  "SessionOrchestrationDeniedError",
  {
    ...SessionOrchestrationErrorFields,
    reason: Schema.Literals([
      "capability_unavailable",
      "disabled_in_settings",
      "not_spawned_by_this_session",
      "spawn_limit_reached",
      "spawn_depth_exceeded",
      "runtime_mode_exceeds_parent",
    ]),
  },
) {}

export class SessionOrchestrationInvalidInputError extends Schema.TaggedErrorClass<SessionOrchestrationInvalidInputError>()(
  "SessionOrchestrationInvalidInputError",
  SessionOrchestrationErrorFields,
) {}

export class SessionOrchestrationUnavailableError extends Schema.TaggedErrorClass<SessionOrchestrationUnavailableError>()(
  "SessionOrchestrationUnavailableError",
  SessionOrchestrationErrorFields,
) {}

export class SessionOrchestrationOperationError extends Schema.TaggedErrorClass<SessionOrchestrationOperationError>()(
  "SessionOrchestrationOperationError",
  SessionOrchestrationErrorFields,
) {}

export const SessionOrchestrationError = Schema.Union([
  SessionOrchestrationDeniedError,
  SessionOrchestrationInvalidInputError,
  SessionOrchestrationUnavailableError,
  SessionOrchestrationOperationError,
]);
export type SessionOrchestrationError = typeof SessionOrchestrationError.Type;
