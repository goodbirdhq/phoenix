import {
  ListSessionProvidersInput,
  ListSessionProvidersResult,
  PostReportInput,
  ReadSessionInput,
  ReadSessionResult,
  SendToSessionInput,
  SendToSessionResult,
  SessionOrchestrationError,
  SessionReport,
  SpawnSessionInput,
  SpawnSessionResult,
  StopSessionInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

export const ListSessionProvidersTool = Tool.make("list_session_providers", {
  description:
    "List the provider instances and models this T3 Code environment can start a new agent session with. Call before spawn_session to offer real choices instead of guessing.",
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
  description:
    "Spawn a new T3 Code agent session (a new thread) that starts working on the given prompt immediately. Choose provider instance, model, and model options (e.g. reasoning effort) from list_session_providers, or omit them to use this session's own provider with defaults. By default the child gets its own git worktree so it cannot conflict with your working tree. The child appears in the user's sidebar like any other thread. End your prompt with report instructions such as: \"When you are done, call post_report with a summary of what you did.\" — the report is delivered back to this session automatically.",
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
    "Read the status of a session this session spawned: live/settled state, its completion report if posted, and optionally its trailing messages. Use for on-demand progress checks; completion is pushed to you automatically, so avoid polling loops.",
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
    "Stop the live agent session of a thread this session spawned. The thread and its history remain; only the running agent stops.",
  parameters: StopSessionInput,
  success: Schema.Null,
  failure: SessionOrchestrationError,
  dependencies,
})
  .annotate(Tool.Title, "Stop spawned session")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const PostReportTool = Tool.make("post_report", {
  description:
    "Post a completion report for THIS session's work: status, a concise markdown summary, and any artifacts (files, branches, PR URLs). If another session spawned this one, the report is delivered to it automatically; the user also sees the report as a card in this thread. Call once when your assigned work is finished (or clearly failed).",
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
