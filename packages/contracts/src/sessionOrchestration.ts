import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderOptionDescriptor, ProviderOptionSelection } from "./model.ts";
import {
  ModelSelection,
  OrchestrationSessionStatus,
  ProviderInteractionMode,
  RuntimeMode,
  SessionReport,
  SessionReportArtifact,
  SessionReportFinding,
  SessionReportOrigin,
  SessionReportStatus,
  SessionReportValidation,
  structuredReportFieldsWithinSizeCap,
  SessionStopReason,
  SessionStoppedBy,
  SessionUsageSnapshot,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Contracts for the `sessions` MCP toolkit: tools a running agent session
 * uses to spawn sibling T3 threads, exchange messages with them, and post a
 * completion report back to whoever spawned it.
 */

// How many active children one thread may spawn, and how deep spawn chains
// may nest. Both caps exist to stop a runaway agent from fork-bombing the
// machine with provider processes.
export const SESSION_SPAWN_MAX_CHILDREN = 8;
export const SESSION_SPAWN_MAX_DEPTH = 3;

// Independent of the active cap: how many total non-deleted, non-archived
// children (active + settled) one thread may retain at once. Settled
// children no longer count toward SESSION_SPAWN_MAX_CHILDREN, so without a
// separate ceiling a parent could spawn/settle indefinitely and accumulate
// unbounded thread rows and worktrees. Archiving a settled child is what
// reclaims a slot under this cap.
export const SESSION_SPAWN_MAX_RETAINED_CHILDREN = 32;

// Cap on how many entries list_sessions returns for a "settled" or "all"
// query, most-recently-created first, so a long-lived parent's report/status
// enrichment (one read per entry) stays bounded. hasMore signals truncation.
export const LIST_SESSIONS_MAX_ENTRIES = 50;

// Reports at or under this size are still delivered inline to the parent;
// larger ones arrive as a compact envelope pointing at read_report.
export const SESSION_REPORT_INLINE_MAX_CHARS = 1024;
// When a large report carries no author abstract, the envelope falls back to
// this many leading characters of the summary.
export const SESSION_REPORT_ABSTRACT_FALLBACK_CHARS = 500;
// Upper bound on one read_report page.
export const READ_REPORT_MAX_CHARS = 16_384;

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

export const QueuedDeliveryReceipt = Schema.Struct({
  messageId: MessageId,
  state: Schema.Literals(["queued", "releasing", "consumed", "cancelled"]),
  requestedAt: IsoDateTime,
  consumedByTurnId: Schema.NullOr(TurnId),
  consumedAt: Schema.NullOr(IsoDateTime),
  cancelledAt: Schema.NullOr(IsoDateTime),
  cancelledReason: Schema.NullOr(Schema.Literals(["session_terminal", "interrupt_timeout"])),
});
export type QueuedDeliveryReceipt = typeof QueuedDeliveryReceipt.Type;

// Compact form a report travels in when delivered to another session: the
// digest plus enough addressing (reportId, threadId, size) to fetch the full
// body with read_report. Small reports carry their whole summary as the
// abstract (`truncated: false`). Structured report data travels compactly:
// the recommendation and completionPercent whole (both small by contract),
// findings/validation as counts only — the full arrays come from read_report.
export const SessionReportEnvelope = Schema.Struct({
  reportId: TrimmedNonEmptyString,
  threadId: ThreadId,
  status: SessionReportStatus,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  // "agent" wrote it itself; "system" is a Phoenix-synthesized terminal
  // report for a session that died before reporting.
  origin: SessionReportOrigin,
  abstract: Schema.String,
  summaryChars: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  // True when `abstract` is not the whole summary; read_report has the rest.
  truncated: Schema.Boolean,
  recommendation: Schema.optional(Schema.String.check(Schema.isMaxLength(1_024))),
  completionPercent: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(100)),
  ),
  findingsCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  validationPerformedCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  validationGapsCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  artifacts: Schema.Array(SessionReportArtifact),
  // What the child cost, captured at report-post time.
  usage: Schema.optional(SessionUsageSnapshot),
  // Both ends of an amendment chain, so a parent holding one envelope can
  // walk to the other with read_report: the earlier report this one amends,
  // and the later report that amended this one.
  supersedesReportId: Schema.optional(TrimmedNonEmptyString),
  supersededByReportId: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});
export type SessionReportEnvelope = typeof SessionReportEnvelope.Type;

// Head-of-summary fallback for reports posted without an abstract. Keeps the
// cut markdown-safe: never ends on half a surrogate pair, and never leaves a
// code fence open (an unterminated ``` would swallow the rest of the parent's
// message when rendered).
const truncatedAbstractFromSummary = (summary: string): string => {
  let head = summary.slice(0, SESSION_REPORT_ABSTRACT_FALLBACK_CHARS - 1);
  const lastCode = head.charCodeAt(head.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    head = head.slice(0, -1);
  }
  const fenceCount = head.split("```").length - 1;
  if (fenceCount % 2 === 1) {
    const lastFence = head.lastIndexOf("```");
    if (lastFence > 0) {
      head = head.slice(0, lastFence).trimEnd();
    } else {
      return `${head}\n\`\`\`\n…`;
    }
  }
  return `${head}…`;
};

export const toSessionReportEnvelope = (report: SessionReport): SessionReportEnvelope => {
  const base = {
    reportId: report.reportId,
    threadId: report.threadId,
    status: report.status,
    title: report.title,
    origin: report.origin,
    summaryChars: report.summary.length,
    ...(report.recommendation !== undefined ? { recommendation: report.recommendation } : {}),
    ...(report.completionPercent !== undefined
      ? { completionPercent: report.completionPercent }
      : {}),
    findingsCount: report.findings?.length ?? 0,
    validationPerformedCount: report.validation?.performed.length ?? 0,
    validationGapsCount: report.validation?.gaps.length ?? 0,
    artifacts: report.artifacts,
    ...(report.usage !== undefined ? { usage: report.usage } : {}),
    ...(report.supersedesReportId !== undefined
      ? { supersedesReportId: report.supersedesReportId }
      : {}),
    ...(report.supersededByReportId !== undefined
      ? { supersededByReportId: report.supersededByReportId }
      : {}),
    createdAt: report.createdAt,
  };
  if (report.summary.length <= SESSION_REPORT_INLINE_MAX_CHARS) {
    return { ...base, abstract: report.summary, truncated: false };
  }
  const abstract =
    report.abstract !== undefined && report.abstract.length > 0
      ? report.abstract
      : truncatedAbstractFromSummary(report.summary);
  return { ...base, abstract, truncated: true };
};

// Native background work still alive after the turn settles (subagent
// fleets, workflow runs, Monitor watch loops) — same vocabulary as
// OrchestrationThreadShell.backgroundLiveness.
export const SessionActivity = Schema.Literals(["working", "monitoring"]);
export type SessionActivity = typeof SessionActivity.Type;

export const SessionPlanProgress = Schema.Struct({
  step: TrimmedNonEmptyString,
  completedSteps: NonNegativeInt,
  totalSteps: NonNegativeInt,
});
export type SessionPlanProgress = typeof SessionPlanProgress.Type;

export const ReadSessionResult = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  sessionStatus: Schema.NullOr(OrchestrationSessionStatus),
  settled: Schema.Boolean,
  // Additive fields (optional): when the child's session last did anything
  // (provider activity timestamp) and what native background work, if any,
  // is still alive. Absent on payloads from pre-ping servers.
  lastActivityAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  currentActivity: Schema.optional(Schema.NullOr(SessionActivity)),
  // Latest report as a compact envelope; fetch the full body (and full
  // findings/validation arrays) via read_report.
  report: Schema.NullOr(SessionReportEnvelope),
  stoppedBy: Schema.NullOr(SessionStoppedBy),
  stopRequestedAt: Schema.NullOr(IsoDateTime),
  stopReason: Schema.NullOr(SessionStopReason),
  interruptedToolCall: Schema.Boolean,
  lastCompletedOperation: Schema.NullOr(TrimmedNonEmptyString),
  messages: Schema.Array(ReadSessionMessage),
  // Present when the spawned session has a git worktree. branch and dirty use
  // cached status; sha is resolved live so callers can verify the revision.
  // A null/absent worktreePath after settle_session cleaned up means the
  // directory is gone: nothing else in the server reclaims these.
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  sha: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  dirty: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export type ReadSessionResult = typeof ReadSessionResult.Type;

export const ListSessionsInput = Schema.Struct({
  // "active" (default): unsettled children — what actually counts toward
  // SESSION_SPAWN_MAX_CHILDREN. "settled": children the parent has declared
  // done but not archived, the pool available to reclaim (send_to_session)
  // or permanently discard (archive_session). "all": both.
  state: Schema.optional(Schema.Literals(["active", "settled", "all"])),
  // Include archived children in the result. Defaults to false, matching
  // the sidebar's default view.
  includeArchived: Schema.optional(Schema.Boolean),
});
export type ListSessionsInput = typeof ListSessionsInput.Type;

export const SessionListEntry = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  sessionStatus: Schema.NullOr(OrchestrationSessionStatus),
  settled: Schema.Boolean,
  archived: Schema.Boolean,
  // Whether the child has posted at least one completion report.
  hasReport: Schema.Boolean,
  // Null once the worktree has been reclaimed (settle_session/archive_session
  // with cleanupWorktree, or a child spawned without one). For a settled
  // child this is the reclaimability signal: resuming a session whose
  // worktree is gone does not currently work, so a null worktreePath here
  // means send_to_session cannot bring it back — archive_session is the only
  // remaining option.
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  modelSelection: ModelSelection,
  createdAt: IsoDateTime,
});
export type SessionListEntry = typeof SessionListEntry.Type;

export const ListSessionsResult = Schema.Struct({
  sessions: Schema.Array(SessionListEntry),
  // True when more matching children exist than LIST_SESSIONS_MAX_ENTRIES
  // returned (state: "settled" or "all" only; "active" is not paginated,
  // since it is already bounded by the spawn cap in steady state).
  hasMore: Schema.Boolean,
});
export type ListSessionsResult = typeof ListSessionsResult.Type;

export const ReadReportInput = Schema.Struct({
  // Report id from a delivery envelope or read_session. When omitted,
  // threadId must be set and the thread's latest report is returned.
  reportId: Schema.optional(TrimmedNonEmptyString),
  // Thread the report belongs to. With reportId it acts as a consistency
  // check; alone it selects that thread's latest report.
  threadId: Schema.optional(ThreadId),
  // Offset into the report summary in UTF-16 code units (same units as
  // totalChars). Defaults to 0. If it lands inside a surrogate pair the page
  // starts at the pair instead; use the returned offset + body.length as the
  // next offset.
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  // Page size in UTF-16 code units. Defaults to (and is capped at) 16384.
  // The page may run one unit short OR one unit long of this to avoid
  // splitting a surrogate pair (long only when maxChars is too small to hold
  // a whole pair, so paging always makes progress).
  maxChars: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
      Schema.isLessThanOrEqualTo(READ_REPORT_MAX_CHARS),
    ),
  ),
});
export type ReadReportInput = typeof ReadReportInput.Type;

export const ReadReportResult = Schema.Struct({
  reportId: TrimmedNonEmptyString,
  threadId: ThreadId,
  status: SessionReportStatus,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  origin: SessionReportOrigin,
  // The requested slice of the report summary.
  body: Schema.String,
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  totalChars: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  hasMore: Schema.Boolean,
  // Full structured report data (the envelope carries only counts). Included
  // on every page rather than behind a flag: they are bounded by the same
  // 32KB contract cap as the report itself, and a read_report caller is
  // explicitly asking for the whole report.
  findings: Schema.optional(Schema.Array(SessionReportFinding).check(Schema.isMaxLength(100))),
  validation: Schema.optional(SessionReportValidation),
  recommendation: Schema.optional(Schema.String.check(Schema.isMaxLength(1_024))),
  completionPercent: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(100)),
  ),
  artifacts: Schema.Array(SessionReportArtifact),
  usage: Schema.optional(SessionUsageSnapshot),
  // Amendment chain, both directions.
  supersedesReportId: Schema.optional(TrimmedNonEmptyString),
  supersededByReportId: Schema.optional(TrimmedNonEmptyString),
  // Present only when this report has been superseded. A caller paging an old
  // body must not have to notice an id field to learn the record moved on, so
  // the fact is also stated in prose it cannot miss.
  supersededNotice: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});
export type ReadReportResult = typeof ReadReportResult.Type;

// The prose half of the marker above. One builder so read_report has a single
// wording, and tests assert against the same string the caller sees.
export const supersededReportNotice = (supersededByReportId: string): string =>
  `SUPERSEDED: this report was amended by a newer report on the same session. Read reportId "${supersededByReportId}" for the current account of the work; treat anything below as out of date.`;

/**
 * Amendments form a single linear chain per thread — never a fork.
 *
 * Two reports both superseding A would leave "which report is current"
 * ambiguous: reverse navigation from A could reach either, while latest-report
 * selection (newest row) picks one of them, and the two answers need not
 * agree. Rather than teach every reader a merge rule, superseding an
 * already-superseded report is refused and the caller is pointed at the head
 * of the chain.
 *
 * Structural on purpose: the decider checks this against folded read-model
 * reports and the toolkit checks it against projection rows, and both must
 * reach the same verdict from the same shape.
 */
export interface ReportSupersessionLink {
  readonly reportId: string;
  // Absent as `undefined` on event/read-model reports and as `null` on
  // projection rows; both spellings mean "supersedes nothing", and neither
  // can equal a report id, so the lookups below treat them identically.
  readonly supersedesReportId?: string | null | undefined;
}

export type ReportSupersessionCheck =
  | { readonly _tag: "ok" }
  // No report with that id on this thread. Deliberately does not distinguish
  // "no such report anywhere" from "belongs to another thread": see
  // SUPERSEDES_REPORT_NOT_FOUND_MESSAGE in the toolkit handlers.
  | { readonly _tag: "unknown-report" }
  | {
      readonly _tag: "already-superseded";
      readonly supersededByReportId: string;
      readonly chainHeadReportId: string;
    };

export const checkReportSupersession = (
  reports: ReadonlyArray<ReportSupersessionLink>,
  supersedesReportId: string,
): ReportSupersessionCheck => {
  if (!reports.some((report) => report.reportId === supersedesReportId)) {
    return { _tag: "unknown-report" };
  }
  const supersederOf = (reportId: string) =>
    reports.find((report) => report.supersedesReportId === reportId);
  const direct = supersederOf(supersedesReportId);
  if (direct === undefined) {
    return { _tag: "ok" };
  }
  // Walk to the end of the chain so the caller is told where to actually
  // attach, not merely that it lost. `seen` bounds the walk: the linear-chain
  // invariant makes a cycle unreachable, but this data crosses a persistence
  // boundary and an infinite loop in the decider would wedge command
  // processing for the whole server.
  let chainHead = direct;
  const seen = new Set<string>([supersedesReportId, direct.reportId]);
  for (;;) {
    const next = supersederOf(chainHead.reportId);
    if (next === undefined || seen.has(next.reportId)) break;
    seen.add(next.reportId);
    chainHead = next;
  }
  return {
    _tag: "already-superseded",
    supersededByReportId: direct.reportId,
    chainHeadReportId: chainHead.reportId,
  };
};

// One wording for the refusal, shared by the toolkit's friendly pre-check and
// the decider's authoritative rejection, so a caller cannot get two different
// explanations of the same state depending on which one caught it.
export const reportAlreadySupersededMessage = (input: {
  readonly reportId: string;
  readonly supersededByReportId: string;
  readonly chainHeadReportId: string;
}): string =>
  input.chainHeadReportId === input.supersededByReportId
    ? `Report ${input.reportId} is already superseded by ${input.supersededByReportId}; supersede ${input.supersededByReportId} instead. Amendments form a single linear chain, so only the newest report in a chain can be amended.`
    : `Report ${input.reportId} is already superseded by ${input.supersededByReportId}, and the current head of that chain is ${input.chainHeadReportId}; supersede ${input.chainHeadReportId} instead. Amendments form a single linear chain, so only the newest report in a chain can be amended.`;

export const PingSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type PingSessionInput = typeof PingSessionInput.Type;

export const PingSessionResult = Schema.Struct({
  threadId: ThreadId,
  sessionStatus: Schema.NullOr(OrchestrationSessionStatus),
  settled: Schema.Boolean,
  // When the child's session last did anything, per the provider session
  // directory's activity tracking — not a turn boundary, so this moves
  // during a long-running turn too.
  lastActivityAt: Schema.NullOr(IsoDateTime),
  // Native background work alive right now (subagent fleets, workflow runs,
  // watch loops); null when the child is idle or mid-turn with no such work.
  currentActivity: Schema.NullOr(SessionActivity),
  // Current plan step while a turn runs; null when the child has no active
  // plan (including once every step completes).
  planProgress: Schema.NullOr(SessionPlanProgress),
  // Whether the child has posted at least one completion report. Does not
  // start a turn or otherwise disturb the child.
  hasReport: Schema.Boolean,
  // Trailing snippet of the child's last assistant message, truncated to
  // ~500 characters; null if it has not said anything yet.
  lastAssistantMessage: Schema.NullOr(BoundedText(500)),
  // Best-effort token/turn budget snapshot. Optional so payloads from
  // pre-usage servers still decode; the current server always populates it.
  usage: Schema.optional(SessionUsageSnapshot),
});
export type PingSessionResult = typeof PingSessionResult.Type;

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

export const SettleSessionInput = Schema.Struct({
  threadId: ThreadId,
  // Permanently delete the child's git worktree and its temporary branch.
  // Refused when the worktree holds work that is not committed and pushed,
  // unless `force` is also set.
  cleanupWorktree: Schema.optional(Schema.Boolean),
  // Also delete a branch Phoenix did not create, once it is proven merged:
  // local head == remote head == the head commit of a merged pull request.
  // Requires `cleanupWorktree`; `force` does not weaken the proof.
  cleanupBranch: Schema.optional(Schema.Boolean),
  // Delete the worktree even though uncommitted or unpushed work would be
  // lost. Only meaningful together with `cleanupWorktree`.
  force: Schema.optional(Schema.Boolean),
});
export type SettleSessionInput = typeof SettleSessionInput.Type;

/**
 * Why a branch could not be proven safe to delete.
 *
 * One vocabulary for both carriers: the error that refuses a cleanup outright,
 * and the per-branch refusal on an otherwise successful cleanup.
 */
export const SessionOrchestrationBranchNotMergedReason = Schema.Literals([
  // No pull-request host reachable (no `gh`, unauthenticated, API down).
  "pull_request_lookup_unavailable",
  // The host answered, but no merged PR has this branch as its head.
  "no_merged_pull_request",
  // The branch has no remote-tracking counterpart to compare against.
  "remote_branch_missing",
  // Local and remote heads disagree: work exists in only one of them.
  "local_ahead_of_remote",
  // The merged PR was merged from a different commit than the branch head.
  "pull_request_head_mismatch",
  // The branch moved between the proof and the delete — either caught by the
  // re-check inside the repository lock, or by git's own compare-and-swap.
  "branch_moved_since_proof",
  // Another linked worktree still has the branch checked out; deleting it
  // would leave that worktree on a HEAD pointing at nothing.
  "branch_checked_out_elsewhere",
  // The worktree list could not be read, so "no other worktree holds this
  // branch" could not be established. Deliberately fails closed.
  "worktree_check_unavailable",
]);
export type SessionOrchestrationBranchNotMergedReason =
  typeof SessionOrchestrationBranchNotMergedReason.Type;

/**
 * A cleanup that removed the worktree but kept the branch, and why.
 *
 * Structured rather than prose because it is a partial success: the caller has
 * to be able to tell "the branch moved, re-settle to re-prove it" from "this
 * repository has no pull-request host" without reading English.
 */
export const SettleSessionBranchRefusal = Schema.Struct({
  branch: TrimmedNonEmptyString,
  reason: SessionOrchestrationBranchNotMergedReason,
  message: Schema.String,
  localSha: Schema.NullOr(TrimmedNonEmptyString),
  remoteSha: Schema.NullOr(TrimmedNonEmptyString),
  // What the proof expected the head to be, when one was taken.
  expectedSha: Schema.NullOr(TrimmedNonEmptyString),
  // The linked worktree still holding the branch, when that is why it stayed.
  conflictingWorktreePath: Schema.NullOr(TrimmedNonEmptyString),
});
export type SettleSessionBranchRefusal = typeof SettleSessionBranchRefusal.Type;

// Exactly what settle_session did to the child's worktree, so the caller can
// always tell what was destroyed and what survived.
export const SettleSessionWorktreeOutcome = Schema.Struct({
  removedWorktreePath: Schema.NullOr(TrimmedNonEmptyString),
  removedBranch: Schema.NullOr(TrimmedNonEmptyString),
  keptWorktreePath: Schema.NullOr(TrimmedNonEmptyString),
  keptBranch: Schema.NullOr(TrimmedNonEmptyString),
  // Why anything was kept: cleanup not requested, no worktree, or a branch
  // Phoenix does not own.
  detail: Schema.NullOr(TrimmedNonEmptyString),
  // What justified deleting `removedBranch`: either that it is a Phoenix
  // temporary branch, or the merge proof (SHAs and the merged PR) that
  // `cleanupBranch` demanded. Null when no branch was deleted.
  branchProof: Schema.NullOr(TrimmedNonEmptyString),
  // Set when the worktree was removed but the branch was deliberately kept
  // despite `cleanupBranch` — the partial-success case, structured so the
  // caller can act on it. Null when no branch cleanup was attempted, or when
  // it succeeded.
  branchRefusal: Schema.NullOr(SettleSessionBranchRefusal),
});
export type SettleSessionWorktreeOutcome = typeof SettleSessionWorktreeOutcome.Type;

export const SettleSessionResult = Schema.Struct({
  threadId: ThreadId,
  settled: Schema.Boolean,
  worktree: SettleSessionWorktreeOutcome,
  // Set when the settle succeeded but something is left for the caller to
  // deal with — today: the child's provider process was still alive when the
  // stop wait timed out. Null when the settle was clean.
  warning: Schema.NullOr(TrimmedNonEmptyString),
});
export type SettleSessionResult = typeof SettleSessionResult.Type;

export const ArchiveSessionInput = Schema.Struct({
  threadId: ThreadId,
  // Permanently delete the child's git worktree and its temporary branch.
  // Defaults to true here (unlike settle_session): once archived, the
  // thread no longer resolves through this toolkit, so this is the last
  // chance to reclaim it. Refused when the worktree holds work that is not
  // committed and pushed, unless `force` is also set.
  cleanupWorktree: Schema.optional(Schema.Boolean),
  // Also delete a branch Phoenix did not create, once it is proven merged:
  // local head == remote head == the head commit of a merged pull request.
  // Requires `cleanupWorktree`; `force` does not weaken the proof. Same
  // semantics as settle_session's `cleanupBranch`.
  cleanupBranch: Schema.optional(Schema.Boolean),
  // Delete the worktree even though uncommitted or unpushed work would be
  // lost. Only meaningful together with `cleanupWorktree`.
  force: Schema.optional(Schema.Boolean),
});
export type ArchiveSessionInput = typeof ArchiveSessionInput.Type;

export const ArchiveSessionResult = Schema.Struct({
  threadId: ThreadId,
  // Whether a live provider binding was confirmed stopped (or found already
  // absent — settledAt alone is never proof of that). Null only when the
  // child was already archived: a retry that hit the idempotent no-op path,
  // where nothing ran at all.
  stopped: Schema.NullOr(Schema.Boolean),
  // Whether the settle cascade (stop + thread.settle) ran. False for an
  // already-settled child, where archive_session still checks for a live
  // binding and stops it if found, but never re-dispatches thread.settle.
  settled: Schema.Boolean,
  worktree: SettleSessionWorktreeOutcome,
  archived: Schema.Boolean,
  // Set when the archive succeeded but a live provider process outlived its
  // stop wait — same meaning as settle_session's warning. Null when clean or
  // when no stop was attempted (nothing to stop, or the already-archived
  // idempotent no-op path).
  warning: Schema.NullOr(TrimmedNonEmptyString),
});
export type ArchiveSessionResult = typeof ArchiveSessionResult.Type;

export const PostReportInput = Schema.Struct({
  status: SessionReportStatus,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  summary: BoundedText(16_384),
  // Short digest (1–3 sentences) shown to the spawning session when the full
  // summary is too large to inline. Omit for small reports.
  abstract: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  artifacts: Schema.optional(Schema.Array(SessionReportArtifact)),
  // Optional machine-readable fields alongside the markdown summary.
  findings: Schema.optional(Schema.Array(SessionReportFinding).check(Schema.isMaxLength(100))),
  validation: Schema.optional(SessionReportValidation),
  recommendation: Schema.optional(Schema.String.check(Schema.isMaxLength(1_024))),
  // 0-100. How much of the assigned work this report represents.
  completionPercent: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(100)),
  ),
  // reportId of an earlier report by THIS session that this one amends and
  // replaces as the session's current account. Must name a report on this
  // same thread. The superseded report is kept and stays readable, flagged as
  // superseded; this one becomes the latest.
  supersedesReportId: Schema.optional(TrimmedNonEmptyString),
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
      "report_not_accessible",
      "spawn_limit_reached",
      "spawn_retention_limit_reached",
      "spawn_depth_exceeded",
      "runtime_mode_exceeds_parent",
      "session_still_running",
    ]),
  },
) {}

/**
 * settle_session refused to delete a worktree that still holds work.
 *
 * Structured rather than a message so the caller can decide what to do with
 * the specific files and commits at risk instead of parsing prose.
 */
export class SessionOrchestrationWorktreeNotEmptyError extends Schema.TaggedErrorClass<SessionOrchestrationWorktreeNotEmptyError>()(
  "SessionOrchestrationWorktreeNotEmptyError",
  {
    ...SessionOrchestrationErrorFields,
    worktreePath: TrimmedNonEmptyString,
    branch: Schema.NullOr(TrimmedNonEmptyString),
    // Paths with uncommitted changes, capped so a huge working tree cannot
    // blow up the tool result.
    dirtyFiles: Schema.Array(TrimmedNonEmptyString),
    dirtyFileCount: NonNegativeInt,
    // Commits on the child's branch that exist nowhere else.
    unpushedCommitCount: NonNegativeInt,
    hasUpstream: Schema.Boolean,
  },
) {}

/**
 * settle_session refused to delete a branch it could not prove is merged.
 *
 * This repository — like most that squash-merge — never makes a merged branch
 * an ancestor of its base, so `git branch --merged` cannot answer the
 * question. The proof is identity instead: the local branch head, the remote
 * branch head, and the head commit of a merged pull request all being the same
 * commit. `reason` says which leg of that failed, and the SHAs say by how much.
 */
export class SessionOrchestrationBranchNotMergedError extends Schema.TaggedErrorClass<SessionOrchestrationBranchNotMergedError>()(
  "SessionOrchestrationBranchNotMergedError",
  {
    ...SessionOrchestrationErrorFields,
    branch: TrimmedNonEmptyString,
    reason: SessionOrchestrationBranchNotMergedReason,
    localSha: Schema.NullOr(TrimmedNonEmptyString),
    remoteSha: Schema.NullOr(TrimmedNonEmptyString),
    mergedPullRequestNumber: Schema.NullOr(NonNegativeInt),
    mergedPullRequestHeadSha: Schema.NullOr(TrimmedNonEmptyString),
  },
) {}

/**
 * A git operation failed because the repository's index/ref lock was held.
 *
 * Structured because the remedy is a specific file path: a git process that
 * died mid-write (the exact failure mode a timed-out `git worktree remove`
 * leaves behind) blocks every later git command on that repository until its
 * lock is removed, and only the caller can confirm no live git process owns it.
 */
export class SessionOrchestrationGitLockError extends Schema.TaggedErrorClass<SessionOrchestrationGitLockError>()(
  "SessionOrchestrationGitLockError",
  {
    ...SessionOrchestrationErrorFields,
    lockPath: TrimmedNonEmptyString,
    // Null when the lock file vanished (or could not be read) between the
    // failing command and the staleness check.
    lockAgeMs: Schema.NullOr(NonNegativeInt),
    // Whether the lock matched the conservative stale heuristic. Phoenix never
    // deletes it on its own: staleness cannot be proven from this process.
    appearsStale: Schema.Boolean,
    remedy: TrimmedNonEmptyString,
  },
) {}

export class SessionOrchestrationInvalidInputError extends Schema.TaggedErrorClass<SessionOrchestrationInvalidInputError>()(
  "SessionOrchestrationInvalidInputError",
  SessionOrchestrationErrorFields,
) {}

/**
 * post_report refused to fork an amendment chain.
 *
 * Structured rather than prose alone because the caller's next move is
 * mechanical: re-post against `chainHeadReportId`. It is also the losing side
 * of a concurrent-amendment race, where the winner's id is the only thing the
 * loser needs to make progress.
 */
export class SessionOrchestrationReportAlreadySupersededError extends Schema.TaggedErrorClass<SessionOrchestrationReportAlreadySupersededError>()(
  "SessionOrchestrationReportAlreadySupersededError",
  {
    ...SessionOrchestrationErrorFields,
    // The report the caller tried to supersede.
    reportId: TrimmedNonEmptyString,
    // The report that already superseded it.
    supersededByReportId: TrimmedNonEmptyString,
    // Newest report in that chain — what to supersede instead. Equal to
    // supersededByReportId unless the chain has grown further.
    chainHeadReportId: TrimmedNonEmptyString,
  },
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
  SessionOrchestrationWorktreeNotEmptyError,
  SessionOrchestrationReportAlreadySupersededError,
  SessionOrchestrationBranchNotMergedError,
  SessionOrchestrationGitLockError,
]);
export type SessionOrchestrationError = typeof SessionOrchestrationError.Type;
