/**
 * conversationSeed - Transcript reconstruction for provider session seeding.
 *
 * When a thread migrates to a different provider instance the new provider
 * session starts fresh, so the conversation has to travel with it. It is
 * rebuilt here from Phoenix's own read model (`projection_thread_messages`)
 * rather than from provider-native session files, which are instance-scoped
 * and non-portable.
 *
 * Adapters consume the result one of two ways (see
 * `ProviderAdapterCapabilities.conversationSeeding`): natively as provider
 * conversation history, or framed into the first prompt via
 * `formatConversationSeedPrompt`.
 *
 * @module conversationSeed
 */
import type {
  ProviderConversationSeed,
  ProviderConversationSeedMessage,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

/**
 * Transfer budget for a reconstructed transcript. A migrated thread can be
 * hundreds of turns long; every provider on the receiving end pays for the
 * seed in context, so the newest slice that fits is what travels.
 */
export interface ConversationSeedLimits {
  /** Newest N messages at most. */
  readonly maxMessages: number;
  /** Budget across all kept messages. */
  readonly maxTotalCharacters: number;
  /** Per-message cap, applied before the total budget. */
  readonly maxMessageCharacters: number;
}

export const CONVERSATION_SEED_LIMITS: ConversationSeedLimits = {
  maxMessages: 60,
  maxTotalCharacters: 60_000,
  maxMessageCharacters: 8_000,
};

const TRUNCATION_MARKER = "\n\n[… message truncated by Phoenix]";

// Below this the remaining budget only buys a useless stub, so stop instead.
const MINIMUM_MESSAGE_CHARACTERS = 200;

export interface ConversationSeedBuild {
  readonly seed: ProviderConversationSeed;
  /** Messages left out entirely, oldest first. */
  readonly droppedMessageCount: number;
  /** Messages kept but shortened. */
  readonly truncatedMessageCount: number;
}

interface SeedSourceMessage {
  readonly role: string;
  readonly text: string;
}

/**
 * Reduce a chronological message list to a seed that fits the transfer budget.
 * Drops oldest-first: the tail of a conversation is what the next agent needs
 * to continue, and the count of what went missing is reported so callers can
 * log it and framed seeds can say so out loud.
 */
export function buildConversationSeed(input: {
  readonly messages: ReadonlyArray<SeedSourceMessage>;
  readonly brief?: string | undefined;
  readonly limits?: ConversationSeedLimits;
}): ConversationSeedBuild {
  const limits = input.limits ?? CONVERSATION_SEED_LIMITS;
  const usable = input.messages.flatMap((message): Array<ProviderConversationSeedMessage> => {
    if (message.role !== "user" && message.role !== "assistant") {
      return [];
    }
    const text = message.text.trim();
    return text.length === 0 ? [] : [{ role: message.role, text }];
  });

  const kept: Array<ProviderConversationSeedMessage> = [];
  let remainingCharacters = limits.maxTotalCharacters;
  let truncatedMessageCount = 0;

  // Walk newest to oldest so the budget is spent on the most recent context.
  for (let index = usable.length - 1; index >= 0; index -= 1) {
    if (kept.length >= limits.maxMessages || remainingCharacters < MINIMUM_MESSAGE_CHARACTERS) {
      break;
    }
    const message = usable[index]!;
    const capped =
      message.text.length > limits.maxMessageCharacters
        ? `${message.text.slice(0, limits.maxMessageCharacters)}${TRUNCATION_MARKER}`
        : message.text;
    const allowance = Math.min(capped.length, remainingCharacters);
    const text =
      allowance < capped.length ? `${capped.slice(0, allowance)}${TRUNCATION_MARKER}` : capped;
    if (text !== message.text) {
      truncatedMessageCount += 1;
    }
    remainingCharacters -= allowance;
    kept.push({ role: message.role, text });
  }

  kept.reverse();
  const droppedMessageCount = usable.length - kept.length;
  const brief = input.brief?.trim();

  return {
    seed: {
      messages: kept,
      ...(brief ? { brief } : {}),
      ...(droppedMessageCount > 0 ? { droppedMessageCount } : {}),
    },
    droppedMessageCount,
    truncatedMessageCount,
  };
}

/**
 * Rebuild a thread's conversation from the read model. Returns `None` when the
 * thread has nothing worth seeding — a caller with no seed is better off
 * starting the new session clean than sending an empty transcript.
 */
export const readThreadConversationSeed = Effect.fn("readThreadConversationSeed")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly brief?: string | undefined;
    readonly limits?: ConversationSeedLimits;
  }) {
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const detail = yield* snapshotQuery.getThreadDetailById(input.threadId);
    if (Option.isNone(detail)) {
      yield* Effect.logWarning("provider.seed.thread-missing", { threadId: input.threadId });
      return Option.none<ProviderConversationSeed>();
    }

    const build = buildConversationSeed({
      messages: detail.value.messages,
      ...(input.brief !== undefined ? { brief: input.brief } : {}),
      ...(input.limits !== undefined ? { limits: input.limits } : {}),
    });

    if (build.seed.messages.length === 0 && build.seed.brief === undefined) {
      return Option.none<ProviderConversationSeed>();
    }

    if (build.droppedMessageCount > 0 || build.truncatedMessageCount > 0) {
      yield* Effect.logInfo("provider.seed.transcript-bounded", {
        threadId: input.threadId,
        keptMessages: build.seed.messages.length,
        droppedMessages: build.droppedMessageCount,
        truncatedMessages: build.truncatedMessageCount,
      });
    }

    return Option.some(build.seed);
  },
);

/**
 * Gate a seed on the session actually being fresh. A session resumed from a
 * provider-native cursor already carries its own history, so seeding it too
 * would replay the whole conversation into context twice.
 */
export const seedForFreshSession = Effect.fn("seedForFreshSession")(function* (input: {
  readonly threadId: ThreadId;
  readonly seed: ProviderConversationSeed | undefined;
  readonly resuming: boolean;
}) {
  if (input.seed === undefined) {
    return undefined;
  }
  if (input.resuming) {
    yield* Effect.logWarning("provider.seed.skipped-on-resume", { threadId: input.threadId });
    return undefined;
  }
  return input.seed;
});

const SEED_OPEN_TAG = "<phoenix-prior-conversation>";
const SEED_CLOSE_TAG = "</phoenix-prior-conversation>";

/**
 * Frame a seed into text for providers that cannot take conversation history
 * natively. The result is prepended to the first prompt of the new session.
 */
export function formatConversationSeedPrompt(seed: ProviderConversationSeed): string | undefined {
  if (seed.messages.length === 0 && seed.brief === undefined) {
    return undefined;
  }

  const lines: Array<string> = [
    SEED_OPEN_TAG,
    "This thread was moved to you from another agent session. The following is the prior",
    "conversation. Continue the work from it — do not restart it, and do not reply to this",
    "block itself. Everything after the closing tag is the user's new message.",
  ];

  if (seed.droppedMessageCount !== undefined && seed.droppedMessageCount > 0) {
    lines.push(
      "",
      `Note: the ${seed.droppedMessageCount} oldest message(s) were dropped to fit the transfer budget.`,
    );
  }

  if (seed.brief !== undefined) {
    lines.push("", "## Handoff brief from the previous agent", "", seed.brief);
  }

  if (seed.messages.length > 0) {
    lines.push("", "## Transcript");
    for (const message of seed.messages) {
      lines.push("", `### ${message.role}`, "", message.text);
    }
  }

  lines.push(SEED_CLOSE_TAG);
  return lines.join("\n");
}

/**
 * Prepend a framed seed to the first prompt of a seeded session. Kept separate
 * from `formatConversationSeedPrompt` so adapters that build content blocks
 * can reuse either half.
 */
export function applyConversationSeedPrefix(input: {
  readonly seedPrompt: string;
  readonly text: string;
}): string {
  const text = input.text.trim();
  return text.length === 0 ? input.seedPrompt : `${input.seedPrompt}\n\n${text}`;
}
