import {
  ListSessionProvidersInput,
  ListSessionProvidersResult,
  PostReportInput,
  ReadSessionInput,
  ReadSessionResult,
  SendToSessionInput,
  SendToSessionResult,
  SESSION_SPAWN_MAX_CHILDREN,
  SessionOrchestrationError,
  SessionReport,
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

export const SpawnSessionTool = Tool.make("spawn_session", {
  description: `Spawn a new Phoenix agent session (a new thread) that starts working on the given prompt immediately. Choose provider instance, model, and model options (e.g. reasoning effort) from list_session_providers, or omit them to use this session's own provider with defaults. By default the child gets its own git worktree so it cannot conflict with your working tree. Use gitRef, baseRef, branchName, or checkoutPr to control that worktree's checkout; checkoutPr and gitRef are mutually exclusive. The child appears in the user's sidebar like any other thread. End your prompt with report instructions such as: "When you are done, call post_report with a summary of what you did." — the report is delivered back to this session automatically. A calling session may have at most ${SESSION_SPAWN_MAX_CHILDREN} spawned children at once, counting stopped and settled ones — archive a child thread (not just stop it) to free a slot.`,
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
    "Send a follow-up user message to a session this session spawned, starting a new turn there. Fails while the child is mid-turn; prefer waiting for its report.",
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
    "Read the status of a session this session spawned: live/settled state, its completion report if posted, and optionally its trailing messages. Use for on-demand progress checks; completion is pushed to you automatically, so avoid polling loops. messageLimit accepts 0-20 (default 5); each returned message is truncated to 16,384 characters.",
  parameters: ReadSessionInput,
  success: ReadSessionResult,
  failure: SessionOrchestrationError,
  dependencies,
})
  .annotate(Tool.Title, "Read spawned session")
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

export const PostReportTool = Tool.make("post_report", {
  description:
    "Post a completion report for THIS session's work: status, a concise markdown summary, and any artifacts (files, branches, PR URLs). If another session spawned this one, the report is delivered to it automatically; the user also sees the report as a card in this thread. Call once when your assigned work is finished (or clearly failed). Optionally include machine-readable fields: findings (array of {title, severity: info|low|medium|high|critical, detail?}), validation ({performed: string[], gaps: string[]}), recommendation (short string), and completionPercent (0-100).",
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
  SpawnSessionTool,
  SendToSessionTool,
  ReadSessionTool,
  StopSessionTool,
  PostReportTool,
);
