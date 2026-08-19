import { CommandId, MessageId, type OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  HANDOFF_BRIEF_PROMPT,
  HandoffBrief,
  HandoffBriefMissingResponseError,
  HandoffBriefTurnFailedError,
  type HandoffBriefShape,
} from "../Services/HandoffBrief.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  RuntimeReceiptBus,
  type ProviderTurnCompletedReceipt,
} from "../Services/RuntimeReceiptBus.ts";

type ThreadSessionSetEvent = Extract<OrchestrationEvent, { type: "thread.session-set" }>;

const isTerminalSessionFailure = (
  event: OrchestrationEvent,
  threadId: ThreadId,
): event is ThreadSessionSetEvent =>
  event.type === "thread.session-set" &&
  event.payload.threadId === threadId &&
  (event.payload.session.status === "error" ||
    event.payload.session.status === "stopped" ||
    event.payload.session.status === "interrupted");

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const receiptBus = yield* RuntimeReceiptBus;

  const create: HandoffBriefShape["create"] = Effect.fn("HandoffBrief.create")(
    function* (threadId) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
          const messageId = MessageId.make(`handoff-brief:${id}`);
          const completionPull = yield* receiptBus.streamEvents.pipe(
            Stream.filter(
              (receipt): receipt is ProviderTurnCompletedReceipt =>
                receipt.type === "provider.turn.completed" &&
                receipt.threadId === threadId &&
                receipt.messageId === messageId,
            ),
            Stream.toPull,
          );
          const failurePull = yield* orchestrationEngine.streamDomainEvents.pipe(
            Stream.filter((event) => isTerminalSessionFailure(event, threadId)),
            Stream.toPull,
          );

          const createdAt = DateTime.formatIso(yield* DateTime.now);
          const { sequence: startSequence } = yield* orchestrationEngine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`handoff-brief:${id}`),
            threadId,
            message: {
              messageId,
              role: "user",
              text: HANDOFF_BRIEF_PROMPT,
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt,
          });

          const completion = completionPull.pipe(
            Effect.orDie,
            Effect.map((receipts) => ({ type: "completed" as const, receipt: receipts[0] })),
          );
          const sessionFailure = Effect.gen(function* () {
            while (true) {
              const events = yield* failurePull.pipe(Effect.orDie);
              const event = events.find((candidate) => candidate.sequence > startSequence);
              if (event) {
                return {
                  type: "failed" as const,
                  detail:
                    event.payload.session.lastError ??
                    `Session became ${event.payload.session.status}.`,
                };
              }
            }
          });
          const outcome = yield* Effect.race(completion, sessionFailure);

          if (outcome.type === "failed") {
            return yield* new HandoffBriefTurnFailedError({
              threadId,
              turnId: null,
              detail: outcome.detail,
            });
          }
          if (outcome.receipt.state !== "completed") {
            return yield* new HandoffBriefTurnFailedError({
              threadId,
              turnId: outcome.receipt.turnId,
              detail:
                outcome.receipt.errorMessage ??
                `Provider turn ended with state '${outcome.receipt.state}'.`,
            });
          }

          const assistantMessageId = outcome.receipt.assistantMessageId;
          const getThreadMessageById = projectionSnapshotQuery.getThreadMessageById;
          if (assistantMessageId === null || getThreadMessageById === undefined) {
            return yield* new HandoffBriefMissingResponseError({
              threadId,
              turnId: outcome.receipt.turnId,
              detail:
                assistantMessageId === null
                  ? "No final assistant message was projected for the turn."
                  : "The turn-scoped message lookup is unavailable.",
            });
          }

          const message = yield* getThreadMessageById(threadId, assistantMessageId);
          if (
            Option.isNone(message) ||
            message.value.role !== "assistant" ||
            message.value.text.trim().length === 0
          ) {
            return yield* new HandoffBriefMissingResponseError({
              threadId,
              turnId: outcome.receipt.turnId,
              detail: "The projected final assistant message is missing or empty.",
            });
          }

          return message.value.text;
        }),
      );
    },
  );

  return HandoffBrief.of({ create });
});

export const HandoffBriefLive = Layer.effect(HandoffBrief, make);
