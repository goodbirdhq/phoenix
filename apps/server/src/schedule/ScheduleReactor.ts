import {
  CommandId,
  MessageId,
  type OccurrenceId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ScheduleId,
  type ScheduleOperationError,
  type ScheduleStoredDefinition,
  type ServerProvider,
  ThreadId,
  isProviderAvailable,
} from "@t3tools/contracts";
import { buildScheduledWorktreeBranchName } from "@t3tools/shared/git";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

import type { ThreadTurnStartCommand } from "../orchestration/ThreadTurnBootstrap.ts";
import type { ScheduleTriggerOutcome } from "./ScheduleDomain.ts";
import { latestScheduleOccurrenceAtOrBefore } from "./timing.ts";

export interface ScheduleOccurrenceRecord {
  readonly occurrenceId: string;
  readonly scheduleId: string;
  readonly scheduledFor: string;
  readonly source: "scheduled" | "manual";
  readonly status: "pending" | "triggering" | "triggered" | "failed";
  readonly threadId: string | null;
  readonly definitionJson: string;
}

type ScheduleOutcome = ScheduleTriggerOutcome & {
  readonly occurrence: ScheduleOccurrenceRecord;
};

type DueOccurrence = ReturnType<typeof latestScheduleOccurrenceAtOrBefore>;

export interface ScheduleReactorPort {
  readonly now: Effect.Effect<string>;
  readonly randomOccurrenceId: (
    scheduleId: ScheduleId,
    operation: string,
  ) => Effect.Effect<OccurrenceId, ScheduleOperationError>;
  readonly loadOccurrence: (
    occurrenceId: OccurrenceId,
  ) => Effect.Effect<ScheduleOccurrenceRecord | null, ScheduleOperationError>;
  readonly decodeDefinition: (
    recordJson: string,
    scheduleId: ScheduleId,
  ) => Effect.Effect<ScheduleStoredDefinition, ScheduleOperationError>;
  readonly readThread: (
    threadId: ThreadId,
    scheduleId: ScheduleId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ScheduleOperationError>;
  readonly cleanupRecoveredThread: (
    threadId: ThreadId,
    scheduleId: ScheduleId,
  ) => Effect.Effect<void, ScheduleOperationError>;
  readonly readProject: (
    definition: ScheduleStoredDefinition,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ScheduleOperationError>;
  readonly readProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly claimOccurrence: (
    occurrenceId: OccurrenceId,
    threadId: ThreadId,
    at: string,
    scheduleId: ScheduleId,
  ) => Effect.Effect<void, ScheduleOperationError>;
  readonly bootstrapTurn: (
    command: ThreadTurnStartCommand,
  ) => Effect.Effect<void, { readonly message: string }>;
  readonly recordOutcome: (outcome: ScheduleOutcome) => Effect.Effect<void, ScheduleOperationError>;
  readonly readDueSchedules: (
    at: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ScheduleStoredDefinition>, ScheduleOperationError>;
  readonly failInvalidTiming: (input: {
    readonly detail: ScheduleStoredDefinition;
    readonly occurrenceId: OccurrenceId;
    readonly at: string;
    readonly cause: unknown;
  }) => Effect.Effect<void, ScheduleOperationError>;
  readonly reserveScheduledOccurrence: (input: {
    readonly detail: ScheduleStoredDefinition;
    readonly occurrenceId: OccurrenceId;
    readonly due: DueOccurrence;
    readonly at: string;
  }) => Effect.Effect<void, ScheduleOperationError>;
  readonly nextPendingOccurrence: () => Effect.Effect<
    { readonly occurrenceId: OccurrenceId; readonly scheduledFor: string } | null,
    ScheduleOperationError
  >;
  readonly nextDueAt: () => Effect.Effect<string | null, ScheduleOperationError>;
  readonly withMutationPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export interface ScheduleReactorShape {
  readonly wake: Effect.Effect<void>;
  readonly triggerOccurrence: (
    occurrenceId: OccurrenceId,
  ) => Effect.Effect<void, ScheduleOperationError>;
  readonly withTriggerPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly drainDue: Effect.Effect<void, ScheduleOperationError>;
  readonly run: Effect.Effect<never, never>;
}

const DUE_RESERVATION_BATCH_SIZE = 100;

function localTriggerTitle(name: string, scheduledFor: string, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const local = DateTime.makeZonedUnsafe(scheduledFor, { timeZone }).pipe(
    DateTime.formatIntl(formatter),
  );
  return `${name} — ${local}`;
}

function unavailableProvider(
  providers: ReadonlyArray<ServerProvider>,
  definition: ScheduleStoredDefinition,
): "provider_unavailable" | "model_unavailable" | null {
  const selected = providers.find(
    ({ instanceId }) => instanceId === definition.execution.modelSelection.instanceId,
  );
  if (
    selected === undefined ||
    !selected.enabled ||
    !selected.installed ||
    !isProviderAvailable(selected) ||
    selected.status === "disabled" ||
    selected.status === "error" ||
    selected.auth.status === "unauthenticated"
  ) {
    return "provider_unavailable";
  }
  return selected.models.some(({ slug }) => slug === definition.execution.modelSelection.model)
    ? null
    : "model_unavailable";
}

export const makeScheduleReactor = Effect.fn("ScheduleReactor.make")(function* (
  port: ScheduleReactorPort,
): Effect.fn.Return<ScheduleReactorShape, never, import("effect/Scope").Scope> {
  const drainPermit = yield* Semaphore.make(1);
  const triggerPermit = yield* Semaphore.make(1);
  const wakes = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);

  const triggerOccurrence = Effect.fn("ScheduleReactor.triggerOccurrence")(function* (
    occurrenceId: OccurrenceId,
  ) {
    const occurrence = yield* port.loadOccurrence(occurrenceId);
    if (
      occurrence === null ||
      occurrence.status === "triggered" ||
      occurrence.status === "failed"
    ) {
      return;
    }
    const definition = yield* port.decodeDefinition(
      occurrence.definitionJson,
      occurrence.scheduleId as ScheduleId,
    );
    const threadId = ThreadId.make(`schedule:${occurrence.occurrenceId}`);
    const existingThread = yield* port.readThread(threadId, definition.id);
    if (Option.isSome(existingThread) && existingThread.value.latestTurn !== null) {
      yield* port.recordOutcome({ occurrence, type: "triggered", threadId });
      return;
    }
    const cleanupRecoveredThread = Option.isSome(existingThread)
      ? port.cleanupRecoveredThread(threadId, definition.id)
      : Effect.void;
    const project = yield* port.readProject(definition);
    if (Option.isNone(project)) {
      yield* cleanupRecoveredThread;
      yield* port.recordOutcome({
        occurrence,
        type: "failed",
        threadId: null,
        code: "project_not_found",
        message: "The target Project no longer exists.",
      });
      return;
    }
    const providerFailure = unavailableProvider(yield* port.readProviders, definition);
    if (providerFailure !== null) {
      yield* cleanupRecoveredThread;
      yield* port.recordOutcome({
        occurrence,
        type: "failed",
        threadId: null,
        code: providerFailure,
        message:
          providerFailure === "provider_unavailable"
            ? "The configured provider is unavailable or disabled."
            : "The configured model is no longer available from this provider.",
      });
      return;
    }
    const at = yield* port.now;
    yield* port.claimOccurrence(occurrenceId, threadId, at, definition.id);
    const execution = definition.execution;
    const prepareWorktree =
      execution.workspaceMode === "worktree" &&
      execution.baseBranch !== null &&
      (Option.isNone(existingThread) || existingThread.value.worktreePath === null)
        ? {
            projectCwd: project.value.workspaceRoot,
            baseBranch: execution.baseBranch,
            branch: buildScheduledWorktreeBranchName(
              definition.projectId,
              definition.id,
              occurrence.occurrenceId,
            ),
            startFromOrigin: true,
            reuseExistingBranchWorktree: true,
          }
        : undefined;
    const command: ThreadTurnStartCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make(`schedule:${occurrence.occurrenceId}:trigger`),
      threadId,
      message: {
        messageId: MessageId.make(`schedule:${occurrence.occurrenceId}:message`),
        role: "user",
        text: definition.prompt,
        attachments: [],
      },
      modelSelection: execution.modelSelection,
      runtimeMode: execution.runtimeMode,
      interactionMode: execution.interactionMode,
      titleSeed: definition.name,
      bootstrap: {
        ...(Option.isNone(existingThread)
          ? {
              createThread: {
                projectId: definition.projectId,
                title: localTriggerTitle(
                  definition.name,
                  occurrence.scheduledFor,
                  definition.timeZone,
                ),
                modelSelection: execution.modelSelection,
                runtimeMode: execution.runtimeMode,
                interactionMode: execution.interactionMode,
                branch: null,
                worktreePath: null,
                spawnedByThreadId: null,
                reportDelivery: null,
                createdAt: at,
              },
            }
          : {
              recoverExistingThread: {
                projectId: definition.projectId,
                projectCwd: project.value.workspaceRoot,
                worktreePath: existingThread.value.worktreePath,
              },
            }),
        ...(prepareWorktree === undefined ? {} : { prepareWorktree }),
        runSetupScript: true,
        setupScriptIdempotencyKey: `schedule:${occurrence.occurrenceId}:setup`,
      },
      createdAt: at,
    };
    yield* port.bootstrapTurn(command).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          port.recordOutcome({
            occurrence: { ...occurrence, threadId },
            type: "failed",
            threadId: null,
            code: "thread_bootstrap_rejected",
            message: error.message,
          }),
        onSuccess: () =>
          port.recordOutcome({
            occurrence: { ...occurrence, threadId },
            type: "triggered",
            threadId,
          }),
      }),
    );
  });

  const reserveDueBatch = Effect.fn("ScheduleReactor.reserveDueBatch")(function* () {
    const at = yield* port.now;
    const dueSchedules = yield* Effect.forEach(
      yield* port.readDueSchedules(at, DUE_RESERVATION_BATCH_SIZE),
      (detail) =>
        Effect.gen(function* () {
          if (detail.nextOccurrenceAt === null) return Option.none();
          const due = Result.try({
            try: () =>
              latestScheduleOccurrenceAtOrBefore(
                detail.timing,
                detail.timeZone,
                detail.nextOccurrenceAt as string,
                at,
              ),
            catch: (cause) =>
              cause instanceof Error ? cause : new Error("The saved Schedule timing is invalid."),
          });
          if (Result.isFailure(due)) {
            const occurrenceId = yield* port.randomOccurrenceId(
              detail.id,
              "reserve invalid Occurrence identity",
            );
            yield* port.failInvalidTiming({ detail, occurrenceId, at, cause: due.failure });
            return Option.none();
          }
          return Option.some({ detail, due: due.success });
        }),
    );
    const selected = dueSchedules
      .flatMap((candidate) => (Option.isSome(candidate) ? [candidate.value] : []))
      .sort(
        (left, right) =>
          left.due.scheduledFor.localeCompare(right.due.scheduledFor) ||
          left.detail.createdAt.localeCompare(right.detail.createdAt) ||
          left.detail.id.localeCompare(right.detail.id),
      );
    yield* Effect.forEach(selected, ({ detail, due }) =>
      Effect.gen(function* () {
        const occurrenceId = yield* port.randomOccurrenceId(
          detail.id,
          "reserve Occurrence identity",
        );
        yield* port.reserveScheduledOccurrence({
          detail,
          occurrenceId,
          due,
          at,
        });
      }),
    );
    return dueSchedules.length;
  });

  const drainDue = drainPermit.withPermits(1)(
    Effect.gen(function* () {
      while (true) {
        const processed = yield* port.withMutationPermit(reserveDueBatch());
        const unseenDueAt = yield* port.nextDueAt();
        let triggered = 0;
        while (triggered < DUE_RESERVATION_BATCH_SIZE) {
          const pending = yield* port.nextPendingOccurrence();
          // Pending work older than the next unreserved definition is globally
          // safe to Trigger without scanning the remaining overdue definitions.
          if (pending === null || (unseenDueAt !== null && pending.scheduledFor >= unseenDueAt)) {
            break;
          }
          yield* triggerPermit.withPermits(1)(triggerOccurrence(pending.occurrenceId));
          triggered += 1;
        }
        if (processed === 0 && triggered === 0) return;
        yield* Effect.yieldNow;
      }
    }).pipe(Effect.withSpan("ScheduleReactor.drainDue")),
  );

  const run = Effect.scoped(
    Effect.gen(function* () {
      const wakeSubscription = yield* PubSub.subscribe(wakes);
      while (true) {
        const drainFailed = yield* drainDue.pipe(
          Effect.as(false),
          Effect.catch((error) =>
            Effect.logError("Schedule reactor drain failed", { error: error.message }).pipe(
              Effect.as(true),
            ),
          ),
        );
        if (drainFailed) {
          yield* Effect.race(Effect.sleep(Duration.seconds(5)), PubSub.take(wakeSubscription));
          continue;
        }
        const next = yield* port
          .nextDueAt()
          .pipe(
            Effect.catch((error) =>
              Effect.logError("Schedule reactor next-due query failed", { error }).pipe(
                Effect.as(null),
              ),
            ),
          );
        if (next === null) {
          yield* PubSub.take(wakeSubscription);
          continue;
        }
        const delayMs = Math.max(
          0,
          DateTime.toEpochMillis(DateTime.makeUnsafe(next)) -
            DateTime.toEpochMillis(yield* DateTime.now),
        );
        yield* Effect.race(Effect.sleep(Duration.millis(delayMs)), PubSub.take(wakeSubscription));
      }
    }),
  );

  const withTriggerPermit = Effect.fn("ScheduleReactor.withTriggerPermit")(function* <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E, R> {
    return yield* triggerPermit.withPermits(1)(effect);
  });

  return {
    wake: PubSub.publish(wakes, undefined).pipe(Effect.asVoid),
    triggerOccurrence,
    withTriggerPermit,
    drainDue,
    run,
  };
});
