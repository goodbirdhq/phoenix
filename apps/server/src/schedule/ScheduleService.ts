import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CommandId,
  OccurrenceId,
  ScheduleCommand as ScheduleCommandSchema,
  type ScheduleCommand,
  type ScheduleDetail,
  ScheduleDomainEvent as ScheduleDomainEventSchema,
  type ScheduleDomainEvent,
  type ScheduleDispatchResult,
  type ScheduleExecution,
  type ScheduleGetHistoryInput,
  ScheduleHistoryCursor,
  ScheduleHistoryEntry as ScheduleHistoryEntrySchema,
  type ScheduleHistoryPage,
  type ScheduleId,
  type ScheduleListSnapshot,
  type ScheduleListStreamEvent,
  ScheduleOperationError,
  type ScheduleOperationFailure,
  ScheduleStoredDefinition as StoredScheduleDetailSchema,
  type ScheduleStoredDefinition as StoredScheduleDetail,
  type ScheduleSummary,
  type ThreadId,
} from "@t3tools/contracts";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadTurnBootstrap from "../orchestration/ThreadTurnBootstrap.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import {
  decideInvalidTimingFailure,
  decideOccurrenceOutcome,
  decideSchedule,
  decideScheduledOccurrenceReservation,
  evolveScheduleDefinition,
  keepsOneTimeOccurrence,
  type ScheduleHistoryWrite,
  type ScheduleLifecycleDecision,
} from "./ScheduleDomain.ts";
import {
  makeScheduleReactor,
  type ScheduleOccurrenceRecord,
  type ScheduleReactorPort,
} from "./ScheduleReactor.ts";
import { previewScheduleTiming } from "./timing.ts";

interface ScheduleRow {
  readonly scheduleId: string;
  readonly recordJson: string;
  readonly sequence: number;
}

interface ScheduleCommandRow {
  readonly scheduleId: string;
  readonly resultSequence: number;
  readonly commandJson: string | null;
}

interface ScheduleHistoryRow {
  readonly historySequence: number;
  readonly recordJson: string;
}

const operationError = (
  failure: ScheduleOperationFailure,
  message: string,
  scheduleId?: ScheduleId,
  cause?: unknown,
) =>
  new ScheduleOperationError({
    failure,
    message,
    ...(scheduleId === undefined ? {} : { scheduleId }),
    ...(cause === undefined ? {} : { cause }),
  });

const persistenceError = (operation: string, scheduleId?: ScheduleId) => (cause: unknown) =>
  operationError("persistence_failed", `Failed to ${operation} Schedule state.`, scheduleId, cause);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const isScheduleOperationError = Schema.is(ScheduleOperationError);

type ProjectedScheduleDetail = StoredScheduleDetail & { readonly revision: number };

function summaryOf(
  detail: StoredScheduleDetail | ScheduleDetail,
  revision: number,
): ScheduleSummary {
  return {
    id: detail.id,
    projectId: detail.projectId,
    name: detail.name,
    timing: detail.timing,
    timeZone: detail.timeZone,
    execution: detail.execution,
    state: detail.state,
    nextOccurrenceAt: detail.nextOccurrenceAt,
    latestHistory: detail.latestHistory,
    unacknowledgedFailure: detail.unacknowledgedFailure,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    revision,
  };
}

function validateExecution(execution: ScheduleExecution, scheduleId?: ScheduleId): void {
  if (execution.workspaceMode === "worktree") {
    if (execution.baseBranch === null) {
      throw operationError(
        "invalid_workspace",
        "Worktree mode requires an explicit base branch.",
        scheduleId,
      );
    }
  }
}

const StoredScheduleDetailJson = Schema.fromJsonString(StoredScheduleDetailSchema);
const ScheduleHistoryEntryJson = Schema.fromJsonString(ScheduleHistoryEntrySchema);
const ScheduleDomainEventJson = Schema.fromJsonString(ScheduleDomainEventSchema);
const ScheduleCommandJson = Schema.fromJsonString(ScheduleCommandSchema);
const decodeStoredScheduleDetailJson = Schema.decodeUnknownEffect(StoredScheduleDetailJson);
const encodeStoredScheduleDetailJson = Schema.encodeEffect(StoredScheduleDetailJson);
const decodeScheduleHistoryEntryJson = Schema.decodeUnknownEffect(ScheduleHistoryEntryJson);
const encodeScheduleHistoryEntryJson = Schema.encodeEffect(ScheduleHistoryEntryJson);
const encodeScheduleDomainEventJson = Schema.encodeEffect(ScheduleDomainEventJson);
const encodeScheduleCommandJson = Schema.encodeEffect(ScheduleCommandJson);
const DETAIL_HISTORY_LIMIT = 50;

const decodeStoredScheduleDetail = Effect.fn("ScheduleService.decodeStoredDetail")(
  (recordJson: string, scheduleId?: ScheduleId) =>
    decodeStoredScheduleDetailJson(recordJson).pipe(
      Effect.mapError(persistenceError("decode", scheduleId)),
    ),
);

export interface ScheduleServiceShape {
  readonly dispatch: (
    command: ScheduleCommand,
  ) => Effect.Effect<ScheduleDispatchResult, ScheduleOperationError>;
  readonly getSnapshot: () => Effect.Effect<ScheduleListSnapshot, ScheduleOperationError>;
  readonly getDetail: (
    scheduleId: ScheduleId,
  ) => Effect.Effect<ScheduleDetail, ScheduleOperationError>;
  readonly getHistory: (
    input: ScheduleGetHistoryInput,
  ) => Effect.Effect<ScheduleHistoryPage, ScheduleOperationError>;
  readonly subscribe: Effect.Effect<
    Stream.Stream<ScheduleListStreamEvent, ScheduleOperationError>,
    ScheduleOperationError,
    Scope.Scope
  >;
  readonly drainDue: Effect.Effect<void, ScheduleOperationError>;
  readonly runScheduler: Effect.Effect<never, never>;
}

export class ScheduleService extends Context.Service<ScheduleService, ScheduleServiceShape>()(
  "t3/schedule/ScheduleService",
) {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const threadBootstrap = yield* ThreadTurnBootstrap.ThreadTurnBootstrap;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const mutationMutex = yield* Semaphore.make(1);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ScheduleListStreamEvent>(),
    PubSub.shutdown,
  );

  const findCommand = Effect.fn("ScheduleService.findCommand")((commandId: CommandId) =>
    sql<ScheduleCommandRow>`
        SELECT schedule_id AS "scheduleId", result_sequence AS "resultSequence",
          command_json AS "commandJson"
        FROM schedule_commands
        WHERE command_id = ${commandId}
        LIMIT 1
      `.pipe(Effect.mapError(persistenceError("read command receipt"))),
  );

  const findRow = Effect.fn("ScheduleService.findRow")((scheduleId: ScheduleId) =>
    sql<ScheduleRow>`
        SELECT schedule_id AS "scheduleId", record_json AS "recordJson", sequence
        FROM schedule_definitions
        WHERE schedule_id = ${scheduleId}
        LIMIT 1
      `.pipe(Effect.mapError(persistenceError("read", scheduleId))),
  );

  const loadStoredDetail = Effect.fn("ScheduleService.loadStoredDetail")(function* (
    scheduleId: ScheduleId,
  ) {
    const rows = yield* findRow(scheduleId);
    const row = rows[0];
    if (row === undefined) {
      return yield* operationError("not_found", "Schedule was not found.", scheduleId);
    }
    const detail = yield* decodeStoredScheduleDetail(row.recordJson, scheduleId);
    return { ...detail, revision: row.sequence } satisfies ProjectedScheduleDetail;
  });

  const readHistoryPage = Effect.fn("ScheduleService.readHistoryPage")(function* (input: {
    readonly scheduleId: ScheduleId;
    readonly cursor?: ScheduleHistoryCursor;
    readonly limit: number;
  }) {
    const beforeSequence = input.cursor === undefined ? undefined : Number(input.cursor);
    const rows = yield* (
      beforeSequence === undefined
        ? sql<ScheduleHistoryRow>`
          SELECT history_sequence AS "historySequence", record_json AS "recordJson"
          FROM schedule_history
          WHERE schedule_id = ${input.scheduleId}
          ORDER BY history_sequence DESC
          LIMIT ${input.limit + 1}
        `
        : sql<ScheduleHistoryRow>`
          SELECT history_sequence AS "historySequence", record_json AS "recordJson"
          FROM schedule_history
          WHERE schedule_id = ${input.scheduleId} AND history_sequence < ${beforeSequence}
          ORDER BY history_sequence DESC
          LIMIT ${input.limit + 1}
        `
    ).pipe(Effect.mapError(persistenceError("read history", input.scheduleId)));
    const selected = rows.slice(0, input.limit);
    const entries = yield* Effect.forEach(selected, (row) =>
      decodeScheduleHistoryEntryJson(row.recordJson).pipe(
        Effect.mapError(persistenceError("decode history", input.scheduleId)),
      ),
    );
    const oldest = selected[selected.length - 1];
    return {
      scheduleId: input.scheduleId,
      entries: entries.toReversed(),
      nextCursor:
        rows.length > input.limit && oldest !== undefined
          ? ScheduleHistoryCursor.make(String(oldest.historySequence))
          : null,
    } satisfies ScheduleHistoryPage;
  });

  const loadDetail = Effect.fn("ScheduleService.loadDetail")(function* (scheduleId: ScheduleId) {
    const stored = yield* loadStoredDetail(scheduleId);
    const page = yield* readHistoryPage({ scheduleId, limit: DETAIL_HISTORY_LIMIT });
    return {
      ...stored,
      history: page.entries,
      historyNextCursor: page.nextCursor,
    } satisfies ScheduleDetail;
  });

  const listStoredDetails = Effect.fn("ScheduleService.listStoredDetails")(function* () {
    const rows = yield* sql<ScheduleRow>`
      SELECT schedule_id AS "scheduleId", record_json AS "recordJson", sequence
      FROM schedule_definitions
      ORDER BY created_at ASC, schedule_id ASC
    `.pipe(Effect.mapError(persistenceError("list")));
    return yield* Effect.forEach(rows, (row) =>
      decodeStoredScheduleDetail(row.recordJson, row.scheduleId as ScheduleId).pipe(
        Effect.map(
          (detail) => ({ ...detail, revision: row.sequence }) satisfies ProjectedScheduleDetail,
        ),
      ),
    );
  });

  const getSnapshot: ScheduleServiceShape["getSnapshot"] = Effect.fn("ScheduleService.getSnapshot")(
    function* () {
      const details = yield* listStoredDetails();
      const sequenceRows = yield* sql<{ readonly sequence: number | null }>`
      SELECT MAX(sequence) AS sequence FROM schedule_events
    `.pipe(Effect.mapError(persistenceError("read snapshot sequence")));
      return {
        sequence: sequenceRows[0]?.sequence ?? 0,
        schedules: details.map((detail) => summaryOf(detail, detail.revision)),
        updatedAt: yield* nowIso,
      };
    },
  );

  const getDetail: ScheduleServiceShape["getDetail"] = loadDetail;
  const getHistory: ScheduleServiceShape["getHistory"] = Effect.fn("ScheduleService.getHistory")(
    function* (input) {
      yield* loadStoredDetail(input.scheduleId);
      return yield* readHistoryPage({
        scheduleId: input.scheduleId,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        limit: input.limit ?? DETAIL_HISTORY_LIMIT,
      });
    },
  );

  const appendEvent = Effect.fn("ScheduleService.appendEvent")(
    (input: {
      readonly scheduleId: ScheduleId;
      readonly event: ScheduleDomainEvent;
      readonly createdAt: string;
    }) =>
      encodeScheduleDomainEventJson(input.event).pipe(
        Effect.flatMap(
          (payloadJson) => sql<{ readonly sequence: number }>`
        INSERT INTO schedule_events (
          schedule_id, event_type, payload_json, payload_version, created_at
        ) VALUES (
          ${input.scheduleId}, ${input.event.type}, ${payloadJson}, 2, ${input.createdAt}
        )
        RETURNING sequence
      `,
        ),
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.fail(
                operationError(
                  "persistence_failed",
                  "Schedule event did not receive a durable sequence.",
                  input.scheduleId,
                ),
              )
            : Effect.succeed(rows[0].sequence),
        ),
        Effect.mapError((error) =>
          isScheduleOperationError(error)
            ? error
            : persistenceError("append event", input.scheduleId)(error),
        ),
      ),
  );

  const writeDetail = Effect.fn("ScheduleService.writeDetail")(
    (detail: StoredScheduleDetail, sequence: number) =>
      encodeStoredScheduleDetailJson(detail).pipe(
        Effect.flatMap(
          (recordJson) => sql`
        INSERT INTO schedule_definitions (
          schedule_id, project_id, record_json, state, next_occurrence_at,
          created_at, updated_at, sequence
        ) VALUES (
          ${detail.id}, ${detail.projectId}, ${recordJson}, ${detail.state},
          ${detail.nextOccurrenceAt}, ${detail.createdAt}, ${detail.updatedAt}, ${sequence}
        )
        ON CONFLICT (schedule_id) DO UPDATE SET
          project_id = excluded.project_id,
          record_json = excluded.record_json,
          state = excluded.state,
          next_occurrence_at = excluded.next_occurrence_at,
          updated_at = excluded.updated_at,
          sequence = excluded.sequence
      `,
        ),
        Effect.mapError(persistenceError("write", detail.id)),
      ),
  );

  const writeReceipt = Effect.fn("ScheduleService.writeReceipt")(
    (command: ScheduleCommand, sequence: number, acceptedAt: string) =>
      encodeScheduleCommandJson(command).pipe(
        Effect.flatMap(
          (commandJson) => sql`
          INSERT INTO schedule_commands (
            command_id, schedule_id, result_sequence, accepted_at, command_json
          ) VALUES (
            ${command.commandId}, ${command.scheduleId}, ${sequence}, ${acceptedAt}, ${commandJson}
          )
          ON CONFLICT (command_id) DO NOTHING
        `,
        ),
        Effect.mapError(persistenceError("write command receipt", command.scheduleId)),
      ),
  );

  const publishUpsert = Effect.fn("ScheduleService.publishUpsert")(
    (detail: StoredScheduleDetail | ScheduleDetail, sequence: number) =>
      PubSub.publish(changes, {
        type: "schedule-upserted",
        sequence,
        schedule: summaryOf(detail, sequence),
      }).pipe(Effect.asVoid),
  );

  const validateDefinition = Effect.fn("ScheduleService.validateDefinition")(function* (
    definition: Pick<ScheduleDetail, "id" | "projectId" | "timing" | "timeZone" | "execution">,
    at: string,
    options?: { readonly allowPastOneTime?: boolean },
  ) {
    const project = yield* projection
      .getProjectShellById(definition.projectId)
      .pipe(Effect.mapError(persistenceError("read target Project", definition.id)));
    if (Option.isNone(project)) {
      return yield* operationError(
        "project_not_found",
        "The target Project no longer exists.",
        definition.id,
      );
    }
    yield* Effect.try({
      // Repository identity describes the configured remote, not whether the
      // workspace is a local Git repository. The bootstrap boundary performs
      // the authoritative VCS check when an Occurrence is Triggered.
      try: () => validateExecution(definition.execution, definition.id),
      catch: (cause) =>
        isScheduleOperationError(cause)
          ? cause
          : operationError(
              "invalid_workspace",
              "Invalid Schedule workspace settings.",
              definition.id,
              cause,
            ),
    });
    if (definition.execution.workspaceMode === "worktree") {
      const status = yield* gitWorkflow
        .localStatus({ cwd: project.value.workspaceRoot })
        .pipe(
          Effect.mapError((cause) =>
            operationError(
              "invalid_workspace",
              "Could not validate the target Git workspace.",
              definition.id,
              cause,
            ),
          ),
        );
      if (!status.isRepo) {
        return yield* operationError(
          "invalid_workspace",
          "Worktree mode requires the target Project to be a Git repository.",
          definition.id,
        );
      }
    }
    return yield* Effect.try({
      try: () => previewScheduleTiming(definition.timing, definition.timeZone, at, options),
      catch: (cause) =>
        operationError(
          cause instanceof Error && /time zone/i.test(cause.message)
            ? "invalid_time_zone"
            : "invalid_timing",
          cause instanceof Error ? cause.message : "Invalid Schedule timing.",
          definition.id,
          cause,
        ),
    });
  });

  const persistMutation = Effect.fn("ScheduleService.persistMutation")(
    (input: {
      readonly command: ScheduleCommand;
      readonly previous: StoredScheduleDetail | null;
      readonly detail: StoredScheduleDetail;
      readonly event: ScheduleDomainEvent;
      readonly at: string;
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (input.command.type === "schedule.update" || input.command.type === "schedule.pause") {
            yield* sql`
            DELETE FROM schedule_occurrences
            WHERE schedule_id = ${input.detail.id} AND source = 'scheduled' AND status = 'pending'
          `;
          }
          if (
            input.command.type === "schedule.delete" ||
            input.command.type === "schedule.run-now"
          ) {
            return yield* Effect.die("Delete and Run now use dedicated persistence paths.");
          }
          const sequence = yield* appendEvent({
            scheduleId: input.detail.id,
            event: input.event,
            createdAt: input.at,
          });
          const projected = evolveScheduleDefinition(input.previous, input.event);
          if (projected === null) {
            return yield* Effect.die("A Schedule mutation unexpectedly deleted its projection.");
          }
          yield* writeDetail(projected, sequence);
          yield* writeReceipt(input.command, sequence, input.at);
          return { sequence, detail: projected };
        }),
      ),
  );

  const reserveRunNow = Effect.fn("ScheduleService.reserveRunNow")(function* (
    command: Extract<ScheduleCommand, { type: "schedule.run-now" }>,
    detail: StoredScheduleDetail,
    event: Extract<ScheduleDomainEvent, { type: "schedule.occurrence-reserved"; source: "manual" }>,
    at: string,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const sequence = yield* appendEvent({
            scheduleId: detail.id,
            event,
            createdAt: at,
          });
          const definitionJson = yield* encodeStoredScheduleDetailJson(detail).pipe(
            Effect.mapError(persistenceError("encode Run now", detail.id)),
          );
          yield* sql`
          INSERT INTO schedule_occurrences (
            occurrence_id, schedule_id, scheduled_for, source, status, thread_id,
            definition_json, created_at, updated_at
          ) VALUES (
            ${command.occurrenceId}, ${command.scheduleId}, ${at}, 'manual', 'pending', NULL,
            ${definitionJson}, ${at}, ${at}
          )
          ON CONFLICT (occurrence_id) DO NOTHING
        `;
          const projected = evolveScheduleDefinition(detail, event);
          if (projected === null) {
            return yield* Effect.die("Run now unexpectedly deleted its Schedule projection.");
          }
          yield* writeDetail(projected, sequence);
          yield* writeReceipt(command, sequence, at);
          return { sequence, detail: projected };
        }),
      )
      .pipe(Effect.mapError(persistenceError("reserve Run now", command.scheduleId)));
  });

  const mutate = Effect.fn("ScheduleService.mutate")(function* (command: ScheduleCommand) {
    const prior = yield* findCommand(command.commandId);
    if (prior[0] !== undefined) {
      const commandJson = yield* encodeScheduleCommandJson(command).pipe(
        Effect.mapError(persistenceError("compare command receipt", command.scheduleId)),
      );
      if (
        prior[0].scheduleId !== command.scheduleId ||
        prior[0].commandJson === null ||
        prior[0].commandJson !== commandJson
      ) {
        return yield* operationError(
          "command_conflict",
          "This command identity was already accepted with a different payload.",
          command.scheduleId,
        );
      }
      return {
        sequence: prior[0].resultSequence,
        scheduleId: prior[0].scheduleId as ScheduleId,
        detail: null,
        prior: true as const,
      };
    }

    const at = yield* nowIso;
    if (command.type === "schedule.create") {
      const existingRows = yield* findRow(command.scheduleId);
      const current =
        existingRows[0] === undefined
          ? null
          : yield* decodeStoredScheduleDetail(existingRows[0].recordJson, command.scheduleId);
      if (current !== null) {
        const decision = decideSchedule({ current, command, facts: { at } });
        if (!decision.ok && decision.error.failure !== "missing_validated_timing") {
          return yield* operationError(
            decision.error.failure,
            decision.error.message,
            command.scheduleId,
          );
        }
        return yield* Effect.die("Create unexpectedly accepted an existing Schedule.");
      }
      const preview = yield* validateDefinition({ id: command.scheduleId, ...command }, at);
      const decision = decideSchedule({
        current: null,
        command,
        facts: { at, nextOccurrenceAt: preview[0] ?? null },
      });
      if (!decision.ok) {
        if (decision.error.failure === "missing_validated_timing") {
          return yield* Effect.die(decision.error.message);
        }
        return yield* operationError(
          decision.error.failure,
          decision.error.message,
          command.scheduleId,
        );
      }
      if (decision.detail === null) {
        return yield* Effect.die("Create unexpectedly deleted its Schedule projection.");
      }
      const persisted = yield* persistMutation({
        command,
        previous: null,
        detail: decision.detail,
        event: decision.event,
        at,
      });
      return { ...persisted, prior: false as const };
    }

    const current = yield* loadStoredDetail(command.scheduleId);
    if (command.type === "schedule.update") {
      const keepsOccurrence = keepsOneTimeOccurrence(current, command);
      const preview = yield* validateDefinition({ id: current.id, ...command }, at, {
        allowPastOneTime: current.state !== "enabled" && keepsOccurrence,
      });
      const decision = decideSchedule({
        current,
        command,
        facts: { at, nextOccurrenceAt: preview[0] ?? null },
      });
      if (!decision.ok) {
        if (decision.error.failure === "missing_validated_timing") {
          return yield* Effect.die(decision.error.message);
        }
        return yield* operationError(
          decision.error.failure,
          decision.error.message,
          command.scheduleId,
        );
      }
      if (decision.detail === null) {
        return yield* Effect.die("Update unexpectedly deleted its Schedule projection.");
      }
      const persisted = yield* persistMutation({
        command,
        previous: current,
        detail: decision.detail,
        event: decision.event,
        at,
      });
      return { ...persisted, prior: false as const };
    }

    if (command.type === "schedule.delete") {
      const decision = decideSchedule({ current, command, facts: { at } });
      if (!decision.ok) {
        if (decision.error.failure === "missing_validated_timing") {
          return yield* Effect.die(decision.error.message);
        }
        return yield* operationError(
          decision.error.failure,
          decision.error.message,
          command.scheduleId,
        );
      }
      const persisted = yield* sql.withTransaction(
        Effect.gen(function* () {
          const sequence = yield* appendEvent({
            scheduleId: current.id,
            event: decision.event,
            createdAt: at,
          });
          if (decision.detail === null) {
            yield* sql`DELETE FROM schedule_definitions WHERE schedule_id = ${current.id}`;
          } else {
            yield* writeDetail(decision.detail, sequence);
          }
          yield* writeReceipt(command, sequence, at);
          return { sequence, detail: null };
        }),
      );
      return { ...persisted, prior: false as const };
    }

    if (command.type === "schedule.run-now") {
      const decision = decideSchedule({ current, command, facts: { at } });
      if (
        !decision.ok ||
        decision.detail === null ||
        decision.event.type !== "schedule.occurrence-reserved" ||
        decision.event.source !== "manual"
      ) {
        return yield* Effect.die("Run now produced an invalid Schedule decision.");
      }
      const persisted = yield* reserveRunNow(command, decision.detail, decision.event, at);
      return { ...persisted, prior: false as const };
    }

    const nextOccurrenceAt =
      command.type === "schedule.resume"
        ? ((yield* validateDefinition(current, at))[0] ?? null)
        : undefined;
    const decision = decideSchedule({
      current,
      command,
      facts: { at, ...(nextOccurrenceAt === undefined ? {} : { nextOccurrenceAt }) },
    });
    if (!decision.ok) {
      if (decision.error.failure === "missing_validated_timing") {
        return yield* Effect.die(decision.error.message);
      }
      return yield* operationError(
        decision.error.failure,
        decision.error.message,
        command.scheduleId,
      );
    }
    if (decision.detail === null) {
      return yield* Effect.die("Schedule mutation unexpectedly deleted its projection.");
    }
    const persisted = yield* persistMutation({
      command,
      previous: current,
      detail: decision.detail,
      event: decision.event,
      at,
    });
    return { ...persisted, prior: false as const };
  });

  const loadOccurrence = Effect.fn("ScheduleService.loadOccurrence")((occurrenceId: OccurrenceId) =>
    sql<ScheduleOccurrenceRecord>`
        SELECT occurrence_id AS "occurrenceId", schedule_id AS "scheduleId",
          scheduled_for AS "scheduledFor", source, status, thread_id AS "threadId",
          definition_json AS "definitionJson"
        FROM schedule_occurrences
        WHERE occurrence_id = ${occurrenceId}
        LIMIT 1
      `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      Effect.mapError(persistenceError("read Occurrence")),
    ),
  );

  const persistHistoryWrite = Effect.fn("ScheduleService.persistHistoryWrite")(function* (
    scheduleId: ScheduleId,
    write: ScheduleHistoryWrite,
    at: string,
  ) {
    const recordJson = yield* encodeScheduleHistoryEntryJson(write.entry).pipe(
      Effect.mapError(persistenceError("encode history", scheduleId)),
    );
    if (write.type === "replace-latest") {
      const replaced = yield* sql<{ readonly historySequence: number }>`
        UPDATE schedule_history
        SET failure_code = ${write.entry.code}, failure_message = ${write.entry.message},
          record_json = ${recordJson}, created_at = ${at}
        WHERE history_sequence = (
          SELECT history_sequence
          FROM schedule_history
          WHERE schedule_id = ${scheduleId}
          ORDER BY history_sequence DESC
          LIMIT 1
        )
        RETURNING history_sequence AS "historySequence"
      `.pipe(Effect.mapError(persistenceError("compact history", scheduleId)));
      if (replaced[0] === undefined) {
        return yield* operationError(
          "persistence_failed",
          "The latest Schedule failure history was not available to compact.",
          scheduleId,
        );
      }
    } else {
      yield* sql`
        INSERT INTO schedule_history (
          schedule_id, kind, failure_code, failure_message, record_json, created_at
        ) VALUES (
          ${scheduleId}, ${write.entry.type},
          ${write.entry.type === "failed" ? write.entry.code : null},
          ${write.entry.type === "failed" ? write.entry.message : null},
          ${recordJson}, ${at}
        )
      `.pipe(Effect.mapError(persistenceError("persist history", scheduleId)));
    }
  });

  const persistLifecycleDecision = Effect.fn("ScheduleService.persistLifecycleDecision")(function* (
    scheduleId: ScheduleId,
    current: StoredScheduleDetail,
    decision: ScheduleLifecycleDecision,
    at: string,
  ) {
    yield* Effect.forEach(decision.history, (write) => persistHistoryWrite(scheduleId, write, at));
    let projected: StoredScheduleDetail | null = current;
    let sequence: number | null = null;
    for (const event of decision.events) {
      sequence = yield* appendEvent({ scheduleId, event, createdAt: at });
      projected = evolveScheduleDefinition(projected, event);
    }
    if (projected === null || sequence === null) {
      return yield* Effect.die("A Schedule lifecycle decision deleted its projection.");
    }
    yield* writeDetail(projected, sequence);
    return { sequence, detail: projected };
  });

  const recordOutcome = Effect.fn("ScheduleService.recordOutcome")(function* (
    input: Parameters<ScheduleReactorPort["recordOutcome"]>[0],
  ) {
    const at = yield* nowIso;
    const scheduleId = input.occurrence.scheduleId as ScheduleId;
    const currentRows = yield* findRow(scheduleId);
    if (currentRows[0] === undefined) return;
    const current = yield* decodeStoredScheduleDetail(currentRows[0].recordJson, scheduleId);
    const sourceDetail = yield* decodeStoredScheduleDetail(
      input.occurrence.definitionJson,
      scheduleId,
    );
    const occurrenceId = input.occurrence.occurrenceId as OccurrenceId;
    const decision = decideOccurrenceOutcome({
      current,
      sourceDefinition: sourceDetail,
      occurrenceId,
      scheduledFor: input.occurrence.scheduledFor,
      source: input.occurrence.source,
      outcome: input,
      at,
    });
    const result = yield* mutationMutex
      .withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
            UPDATE schedule_occurrences
            SET status = ${decision.occurrence.status},
              thread_id = ${decision.occurrence.threadId},
              error_code = ${decision.occurrence.errorCode},
              error_message = ${decision.occurrence.errorMessage}, updated_at = ${at}
            WHERE occurrence_id = ${occurrenceId}
            `;
            return yield* persistLifecycleDecision(scheduleId, current, decision, at);
          }),
        ),
      )
      .pipe(Effect.mapError(persistenceError("record Occurrence outcome", scheduleId)));
    yield* publishUpsert(result.detail, result.sequence);
  });

  const failInvalidDueSchedule = Effect.fn("ScheduleService.failInvalidDueSchedule")(
    function* (input: {
      readonly detail: StoredScheduleDetail;
      readonly occurrenceId: OccurrenceId;
      readonly at: string;
      readonly cause: unknown;
    }) {
      const { at, cause, detail, occurrenceId } = input;
      const decision = decideInvalidTimingFailure({ current: detail, occurrenceId, at, cause });
      const result = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const definitionJson = yield* encodeStoredScheduleDetailJson(detail).pipe(
              Effect.mapError(persistenceError("encode invalid due Occurrence", detail.id)),
            );
            yield* sql`
          INSERT INTO schedule_occurrences (
            occurrence_id, schedule_id, scheduled_for, source, status, thread_id,
            definition_json, error_code, error_message, created_at, updated_at
          ) VALUES (
            ${occurrenceId}, ${detail.id}, ${decision.occurrence.scheduledFor}, 'scheduled',
            ${decision.occurrence.status}, ${decision.occurrence.threadId}, ${definitionJson},
            ${decision.occurrence.errorCode}, ${decision.occurrence.errorMessage}, ${at}, ${at}
          )
        `;
            return yield* persistLifecycleDecision(detail.id, detail, decision, at);
          }),
        )
        .pipe(Effect.mapError(persistenceError("fail invalid due Schedule", detail.id)));
      yield* publishUpsert(result.detail, result.sequence);
    },
  );

  const readDueSchedules = Effect.fn("ScheduleService.readDueSchedules")(function* (
    at: string,
    limit: number,
  ) {
    const rows = yield* sql<ScheduleRow>`
      SELECT schedule_id AS "scheduleId", record_json AS "recordJson", sequence
      FROM schedule_definitions
      WHERE state = 'enabled' AND next_occurrence_at IS NOT NULL AND next_occurrence_at <= ${at}
      ORDER BY next_occurrence_at ASC, created_at ASC, schedule_id ASC
      LIMIT ${limit}
    `.pipe(Effect.mapError(persistenceError("read due Schedules")));
    return yield* Effect.forEach(rows, (row) =>
      decodeStoredScheduleDetail(row.recordJson, row.scheduleId as ScheduleId),
    );
  });

  const reserveScheduledOccurrence = Effect.fn("ScheduleService.reserveScheduledOccurrence")(
    function* (input: Parameters<ScheduleReactorPort["reserveScheduledOccurrence"]>[0]) {
      const { at, detail, due, occurrenceId } = input;
      const decision = decideScheduledOccurrenceReservation({
        occurrenceId,
        scheduledFor: due.scheduledFor,
        nextOccurrenceAt: due.nextOccurrenceAt,
        skipped: due.skipped,
        at,
      });
      const reservation = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const definitionJson = yield* encodeStoredScheduleDetailJson(detail).pipe(
              Effect.mapError(persistenceError("encode due Occurrence", detail.id)),
            );
            yield* sql`
            INSERT INTO schedule_occurrences (
              occurrence_id, schedule_id, scheduled_for, source, status, thread_id,
              definition_json, created_at, updated_at
            ) VALUES (
              ${occurrenceId}, ${detail.id}, ${decision.occurrence.scheduledFor}, 'scheduled',
              ${decision.occurrence.status}, NULL, ${definitionJson}, ${at}, ${at}
            )
          `;
            return yield* persistLifecycleDecision(detail.id, detail, decision, at);
          }),
        )
        .pipe(Effect.mapError(persistenceError("reserve due Occurrence", detail.id)));
      yield* publishUpsert(reservation.detail, reservation.sequence);
    },
  );

  const nextPendingOccurrence = Effect.fn("ScheduleService.nextPendingOccurrence")(() =>
    sql<{ readonly occurrenceId: string; readonly scheduledFor: string }>`
        SELECT occurrence_id AS "occurrenceId", scheduled_for AS "scheduledFor"
        FROM schedule_occurrences
        WHERE status IN ('pending', 'triggering')
        ORDER BY scheduled_for ASC, created_at ASC, occurrence_id ASC
        LIMIT 1
      `.pipe(
      Effect.map((rows) => {
        const row = rows[0];
        return row === undefined
          ? null
          : { occurrenceId: row.occurrenceId as OccurrenceId, scheduledFor: row.scheduledFor };
      }),
      Effect.mapError(persistenceError("read pending Occurrences")),
    ),
  );

  const nextDueAt = Effect.fn("ScheduleService.nextDueAt")(() =>
    sql<{ readonly nextOccurrenceAt: string | null }>`
        SELECT next_occurrence_at AS "nextOccurrenceAt"
        FROM schedule_definitions
        WHERE state = 'enabled' AND next_occurrence_at IS NOT NULL
        ORDER BY next_occurrence_at ASC, created_at ASC, schedule_id ASC
        LIMIT 1
      `.pipe(
      Effect.map((rows) => rows[0]?.nextOccurrenceAt ?? null),
      Effect.mapError(persistenceError("read next due Schedule")),
    ),
  );

  const randomOccurrenceId = Effect.fn("ScheduleService.randomOccurrenceId")(
    (scheduleId: ScheduleId, operation: string) =>
      crypto.randomUUIDv4.pipe(
        Effect.map(OccurrenceId.make),
        Effect.mapError(persistenceError(operation, scheduleId)),
      ),
  );
  const readScheduleThread = Effect.fn("ScheduleService.readScheduleThread")(
    (threadId: ThreadId, scheduleId: ScheduleId) =>
      projection
        .getThreadShellById(threadId)
        .pipe(Effect.mapError(persistenceError("read recovered Thread", scheduleId))),
  );
  const cleanupRecoveredThread = Effect.fn("ScheduleService.cleanupRecoveredThread")(
    (threadId: ThreadId, scheduleId: ScheduleId) =>
      threadBootstrap
        .cleanupRecoveredThread(threadId)
        .pipe(Effect.mapError(persistenceError("clean up recovered Thread", scheduleId))),
  );
  const readScheduleProject = Effect.fn("ScheduleService.readScheduleProject")(
    (definition: StoredScheduleDetail) =>
      projection
        .getProjectShellById(definition.projectId)
        .pipe(Effect.mapError(persistenceError("read target Project", definition.id))),
  );
  const claimOccurrence = Effect.fn("ScheduleService.claimOccurrence")(
    (occurrenceId: OccurrenceId, threadId: ThreadId, at: string, scheduleId: ScheduleId) =>
      sql`
        UPDATE schedule_occurrences
        SET status = 'triggering', thread_id = ${threadId}, updated_at = ${at}
        WHERE occurrence_id = ${occurrenceId} AND status IN ('pending', 'triggering')
      `.pipe(Effect.asVoid, Effect.mapError(persistenceError("claim Occurrence", scheduleId))),
  );
  const bootstrapTurn = Effect.fn("ScheduleService.bootstrapScheduledTurn")(
    (command: ThreadTurnBootstrap.ThreadTurnStartCommand) =>
      threadBootstrap.bootstrapTurnStart(command).pipe(Effect.asVoid),
  );
  const reactor = yield* makeScheduleReactor({
    now: nowIso,
    randomOccurrenceId,
    loadOccurrence,
    decodeDefinition: decodeStoredScheduleDetail,
    readThread: readScheduleThread,
    cleanupRecoveredThread,
    readProject: readScheduleProject,
    readProviders: providerRegistry.getProviders,
    claimOccurrence,
    bootstrapTurn,
    recordOutcome,
    readDueSchedules,
    failInvalidTiming: failInvalidDueSchedule,
    reserveScheduledOccurrence,
    nextPendingOccurrence,
    nextDueAt,
    withMutationPermit: mutationMutex.withPermits(1),
  });
  const drainDue: ScheduleServiceShape["drainDue"] = reactor.drainDue;

  const dispatchUnlocked = Effect.fn("ScheduleService.dispatch")(function* (
    command: ScheduleCommand,
  ) {
    const mutation = yield* mutationMutex
      .withPermits(1)(mutate(command))
      .pipe(
        Effect.mapError((error) =>
          isScheduleOperationError(error)
            ? error
            : persistenceError("dispatch command", command.scheduleId)(error),
        ),
      );
    if (!mutation.prior) {
      if (command.type === "schedule.delete") {
        yield* PubSub.publish(changes, {
          type: "schedule-removed",
          sequence: mutation.sequence,
          scheduleId: command.scheduleId,
        });
      } else if (mutation.detail !== null) {
        yield* publishUpsert(mutation.detail, mutation.sequence);
      }
      yield* reactor.wake;
    }
    if (command.type === "schedule.run-now") {
      yield* reactor.triggerOccurrence(command.occurrenceId);
    }
    return {
      sequence: mutation.sequence,
      scheduleId: mutation.prior ? mutation.scheduleId : command.scheduleId,
    };
  });
  const dispatch: ScheduleServiceShape["dispatch"] = Effect.fn(
    "ScheduleService.dispatchSerialized",
  )((command) => reactor.withTriggerPermit(dispatchUnlocked(command)));

  const subscribe: ScheduleServiceShape["subscribe"] = mutationMutex.withPermits(1)(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      const snapshot = yield* getSnapshot();
      return Stream.concat(
        Stream.make({ type: "schedule-list-reset", snapshot } satisfies ScheduleListStreamEvent),
        Stream.fromSubscription(subscription),
      );
    }),
  );

  const runScheduler: ScheduleServiceShape["runScheduler"] = reactor.run;

  return ScheduleService.of({
    dispatch,
    getSnapshot,
    getDetail,
    getHistory,
    subscribe,
    drainDue,
    runScheduler,
  });
});

export const layer = Layer.effect(ScheduleService, make);

export const reactorLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const schedules = yield* ScheduleService;
    yield* schedules.runScheduler.pipe(Effect.forkScoped);
  }),
);
