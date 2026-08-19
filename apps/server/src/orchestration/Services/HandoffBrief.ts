/**
 * Produces visible, agent-written handoff briefs for thread migration.
 *
 * @module HandoffBrief
 */
import type { ThreadId } from "@t3tools/contracts";
import { ThreadId as ThreadIdSchema, TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { OrchestrationDispatchError } from "../Errors.ts";

export const HANDOFF_BRIEF_PROMPT = `Write a handoff brief for a fresh agent that will continue this thread's work on a different account or provider.

Summarize:
- the current state and goal;
- decisions made and their rationale;
- in-flight work, including what is complete, incomplete, or blocked;
- concrete next steps.

Reference artifacts such as files, commits, and issues by path or identifier instead of duplicating their contents. Include only the context needed to continue. Redact all secrets, credentials, tokens, and other sensitive values. Return only the handoff brief.`;

export class HandoffBriefTurnFailedError extends Schema.TaggedErrorClass<HandoffBriefTurnFailedError>()(
  "HandoffBriefTurnFailedError",
  {
    threadId: ThreadIdSchema,
    turnId: Schema.NullOr(TurnId),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Handoff brief turn failed for thread '${this.threadId}': ${this.detail}`;
  }
}

export class HandoffBriefMissingResponseError extends Schema.TaggedErrorClass<HandoffBriefMissingResponseError>()(
  "HandoffBriefMissingResponseError",
  {
    threadId: ThreadIdSchema,
    turnId: TurnId,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Handoff brief turn '${this.turnId}' completed without a usable final assistant message: ${this.detail}`;
  }
}

export type HandoffBriefError =
  | HandoffBriefTurnFailedError
  | HandoffBriefMissingResponseError
  | OrchestrationDispatchError;

export interface HandoffBriefShape {
  readonly create: (threadId: ThreadId) => Effect.Effect<string, HandoffBriefError>;
}

export class HandoffBrief extends Context.Service<HandoffBrief, HandoffBriefShape>()(
  "t3/orchestration/Services/HandoffBrief",
) {}
