import {
  ArchiveSessionInput,
  ArchiveSessionResult,
  ListSessionProvidersInput,
  ListSessionProvidersResult,
  ListSessionsInput,
  ListSessionsResult,
  PingSessionInput,
  PingSessionResult,
  PostReportInput,
  ReadReportInput,
  ReadReportResult,
  ReadSessionInput,
  ReadSessionResult,
  SendToSessionInput,
  SendToSessionResult,
  SESSION_SPAWN_MAX_CHILDREN,
  SESSION_SPAWN_MAX_RETAINED_CHILDREN,
  SessionOrchestrationError,
  SessionReport,
  SettleSessionInput,
  SettleSessionResult,
  SpawnSessionInput,
  SpawnSessionResult,
  StopSessionInput,
  StopSessionResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

export const ListSessionProvidersTool = Tool.make("list_session_providers", {
  description:
    "List the provider instances and models this Phoenix environment can start a new agent session with. Call before spawn_session to offer real choices instead of guessing.",
  parameters: ListSessionProvidersInput,
  success: ListSessionProvidersResult,
  failure: SessionOrchestrationError,
  dependencies,
})
  .annotate(Tool.Title, "List spawnable providers")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ListSessionsTool = Tool.make("list_sessions", {
  description:
    'List this session\'s spawned children: threadId, title, session status, settled/archived state, whether a report has been posted, worktreePath, provider/model, and creation time. state defaults to "active" — exactly the children counted by the spawn limit: unsettled, or settled with a provider process that has not actually stopped yet (e.g. a settle whose stop timed out). "settled" is the complement: settled AND confirmed stopped, the pool of children safe to reclaim or discard at leisure. "all" is both. A settled child with a non-null worktreePath can be resumed with send_to_session; one with worktreePath: null cannot (resuming after worktree cleanup does not currently work) and archive_session is the only way to permanently discard it — worktreePath is checked on disk with a best-effort existence check, not just read from the cached record. Archived children are omitted unless includeArchived: true. "settled"/"all" queries are always most-recently-created first and return at most 50 entries; hasMore: true means more exist.',
  parameters: ListSessionsInput,
  success: ListSessionsResult,
  failure: SessionOrchestrationError,
  dependencies,
})
  .annotate(Tool.Title, "List spawned sessions")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const SpawnSessionTool = Tool.make("spawn_session", {
  description: `Spawn a new Phoenix agent session (a new thread) that starts working on the given prompt immediately. Choose provider instance, model, and model options (e.g. reasoning effort) from list_session_providers, or omit them to use this session's own provider with defaults. By default the child gets its own git worktree so it cannot conflict with your working tree. Use gitRef, baseRef, branchName, or checkoutPr to control that worktree's checkout; checkoutPr and gitRef are mutually exclusive. The child appears in the user's sidebar like any other thread. End your prompt with report instructions such as: "When you are done, call post_report with a summary of what you did." — the report creates a durable visible notification on this session, but never starts a model turn; use read_report or read_session when you choose to act. A calling session may have at most ${SESSION_SPAWN_MAX_CHILDREN} active (unsettled) spawned children at once — settle a finished child with settle_session to free a slot, or archive_session to permanently discard one and reclaim its worktree. Independently, at most ${SESSION_SPAWN_MAX_RETAINED_CHILDREN} children total (active + settled) may be retained; archive_session on settled ones reclaims capacity there too.`,
  parameters: SpawnSessionInput,
  success: SpawnSessionResult,
  failure: SessionOrchestrationError,
  dependencies,
})
  .annotate(Tool.Title, "Spawn agent session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const SendToSessionTool = Tool.make("send_to_session", {
  description:
    "Send a follow-up user message to a session this session spawned. mode defaults to queue: idle sessions receive it immediately, while busy sessions receive it after the current turn. interrupt stops the current turn first, then sends the message. The result reports immediate, queued, or unknown when the send committed but acknowledgement readback was unavailable.",
  parameters: SendToSessionInput,
  success: SendToSessionResult,
  failure: SessionOrchestrationError,
  dependencies,
})
  .annotate(Tool.Title, "Message spawned session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const ReadSessionTool = Tool.make("read_session", {
  description:
    "Read the status of a session this session spawned: live/settled state, its latest completion report as a compact envelope (title, status, origin, abstract, size, structured counts), and optionally its trailing messages. Use read_report to fetch a report's full body and full findings/validation. Reports create a durable notification rather than starting your model; use this for on-demand progress checks when you choose to act. messageLimit accepts 0-20 (default 5); each returned message is truncated to 16,384 characters.",
  parameters: ReadSessionInput,
  success: ReadSessionResult,
  failure: SessionOrchestrationError,
  dependencies,
})
  .annotate(Tool.Title, "Read spawned session")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const PingSessionTool = Tool.make("ping_session", {
  description:
    "Get a lightweight progress snapshot of a session this session spawned, WITHOUT starting a model turn or interrupting it: session status, whether it has settled, when it last did anything, its current background activity (working/monitoring, from native subagent/workflow/watch-loop work), plan progress if it's mid-plan, whether it has posted a report, pending queued count, its most recent delivery receipt, a snippet of its last assistant message, and a best-effort usage snapshot for budgeting: lastTurnInputTokens/lastTurnOutputTokens (the most recent turn only, NOT a session total, and not comparable across providers since cache-token accounting differs), totalTokens (a provider's own cumulative counter, omitted rather than estimated when not reported), turnCount, elapsedMs since spawn, and lastTurnDurationMs. No cost estimate is included; price tables go stale. Cheap enough to poll; prefer this over read_session for a quick liveness check, and read_session when you want the full report or message history.",
  parameters: PingSessionInput,
  success: PingSessionResult,
  failure: SessionOrchestrationError,
  dependencies,
})
  .annotate(Tool.Title, "Ping spawned session")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const StopSessionTool = Tool.make("stop_session", {
  description:
    "Stop the live agent session of a thread this session spawned. Set gracePeriodMs to deliver a stop notice first, allowing the child to finish its current tool call and optionally post a partial report before Phoenix hard-stops it at the deadline. The thread and its history remain (and still count toward the spawn limit).",
  parameters: StopSessionInput,
  success: StopSessionResult,
  failure: SessionOrchestrationError,
  dependencies,
})
  .annotate(Tool.Title, "Stop spawned session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const SettleSessionTool = Tool.make("settle_session", {
  description:
    "Mark a session this session spawned as finished, so it stops showing up as live work AND frees its spawn slot (the spawn limit only counts active/unsettled children). This STOPS the child's agent process if it is still alive — settling is declaring the child done, so the process goes with it. A child that is mid-turn (starting or running) is refused instead: call stop_session yourself if you really mean to interrupt live work. The child and its worktree stay around, resumable with send_to_session, unless you also pass cleanupWorktree: true to PERMANENTLY DELETE the child's git worktree directory and its temporary Phoenix branch (after which it can no longer be resumed); this cannot be undone, and is refused (with the specific dirty files and unpushed commit count) when the worktree still holds work that is not committed and pushed, unless you also pass force: true. Add cleanupBranch: true to also delete a branch you named yourself, which happens only when Phoenix can prove it was merged (local head == remote head == the head commit of a merged pull request) and is otherwise refused with the SHAs that disagree. Cleanups on one repository run one at a time, so parallel settles queue instead of fighting over git's lock. Use list_sessions with state: \"settled\" to see settled children. The result always lists exactly what was removed, what was kept, and the proof used; a warning field appears when the child's process outlived its stop.",
  parameters: SettleSessionInput,
  success: SettleSessionResult,
  failure: SessionOrchestrationError,
  dependencies,
})
  .annotate(Tool.Title, "Settle spawned session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const ArchiveSessionTool = Tool.make("archive_session", {
  description:
    "Permanently discard a session this session spawned: removes it from view and, by default, reclaims its git worktree/branch. Settled children already stop counting toward the spawn limit and can be resumed with send_to_session — archive this only once you are done with a child for good (it can never be resumed after). Archiving SUBSUMES settling: if the child is not yet settled, this first runs the same stop-then-settle cascade as settle_session, refusing a starting/running child instead (call stop_session or wait, then retry). Unlike settle_session, cleanupWorktree defaults to true here, because an archived thread has no later handle to clean up its worktree; pass cleanupWorktree: false to keep it. Deletion is refused (with the specific dirty files and unpushed commit count) when the worktree still holds work that is not committed and pushed, unless force: true. Add cleanupBranch: true to also delete a branch you named yourself, once Phoenix can prove it was merged (local head == remote head == the head commit of a merged pull request); otherwise refused with the SHAs that disagree. Cleanups on one repository run one at a time, so parallel archives queue instead of fighting over git's lock. An already-settled child is archived directly, still reclaiming its worktree by default. Idempotent: calling this again on a child that is already archived is a no-op success, not an error. The result reports the full cascade: whether a session was stopped, whether a settle ran, what happened to the worktree/branch and the proof used, and that the thread is archived; a warning field appears when the child's process outlived its stop.",
  parameters: ArchiveSessionInput,
  success: ArchiveSessionResult,
  failure: SessionOrchestrationError,
  dependencies,
})
  .annotate(Tool.Title, "Archive spawned session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const ReadReportTool = Tool.make("read_report", {
  description:
    "Read the full body of a completion report posted by a session this session spawned, or by a sibling session (one spawned by the same parent). Pass the reportId from a report envelope, or a threadId to get that thread's latest report. Large reports paginate via offset/maxChars; the result also carries the report's origin (agent vs Phoenix-synthesized) and full findings/validation/recommendation. A report that has been amended comes back with supersededByReportId and a supersededNotice: read that newer report instead, it is the session's current account.",
  parameters: ReadReportInput,
  success: ReadReportResult,
  failure: SessionOrchestrationError,
  dependencies,
})
  .annotate(Tool.Title, "Read session report")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const PostReportTool = Tool.make("post_report", {
  description:
    "Post a completion report for THIS session's work: status, a concise markdown summary, and any artifacts (files, branches, PR URLs). If another session spawned this one, the report creates a durable visible notification on its thread; it never starts a model turn. The parent reads current details with read_report or read_session when it chooses to act. The user also sees the report as a card in this thread. Call once when your assigned work is finished (or clearly failed). If an instruction reaches you AFTER you already reported, do the work and post an AMENDING report: call post_report again with supersedesReportId set to your earlier reportId (it must be a report you posted on this thread, and one that has not itself been superseded — amendments form a single linear chain, so always amend the newest report). The amendment becomes the current report; the superseded report stays readable and is flagged as superseded. Never describe work in a report as done when it was not done at the time that report was written. Optionally include machine-readable fields: findings (array of {title, severity: info|low|medium|high|critical, detail?}), validation ({performed: string[], gaps: string[]}), recommendation (short string), and completionPercent (0-100). The result also carries a best-effort usage snapshot (tokens, turn count, elapsed time since spawn) captured automatically at post time — this is not something you supply.",
  parameters: PostReportInput,
  success: SessionReport,
  failure: SessionOrchestrationError,
  dependencies,
})
  .annotate(Tool.Title, "Post completion report")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const SessionsToolkit = Toolkit.make(
  ListSessionProvidersTool,
  ListSessionsTool,
  SpawnSessionTool,
  SendToSessionTool,
  ReadSessionTool,
  ReadReportTool,
  PingSessionTool,
  StopSessionTool,
  SettleSessionTool,
  ArchiveSessionTool,
  PostReportTool,
);
