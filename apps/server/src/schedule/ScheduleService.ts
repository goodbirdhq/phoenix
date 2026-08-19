import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CommandId,
  MessageId,
  OccurrenceId,
  evolveScheduleDefinition,
  isProviderAvailable,
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
  type ScheduleHistoryEntry,
  type ScheduleHistoryPage,
  type ScheduleId,
  type ScheduleListSnapshot,
  type ScheduleListStreamEvent,
  ScheduleOperationError,
  type ScheduleOperationFailure,
  ScheduleStoredDefinition as StoredScheduleDetailSchema,
  type ScheduleStoredDefinition as StoredScheduleDetail,
  type ScheduleSummary,
  ThreadId,
} from "@t3tools/contracts";
import { buildScheduledWorktreeBranchName } from "@t3tools/shared/git";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadTurnBootstrap from "../orchestration/ThreadTurnBootstrap.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { latestScheduleOccurrenceAtOrBefore, previewScheduleTiming } from "./timing.ts";

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

interface ScheduleOccurrenceRow {
  readonly occurrenceId: string;
  readonly scheduleId: string;
  readonly scheduledFor: string;
  readonly source: "scheduled" | "manual";
  readonly status: "pending" | "triggering" | "triggered" | "failed";
  readonly threadId: string | null;
  readonly definitionJson: string;
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
const DUE_RESERVATION_BATCH_SIZE = 100;

const decodeStoredScheduleDetail = (recordJson: string, scheduleId?: ScheduleId) =>
  decodeStoredScheduleDetailJson(recordJson).pipe(
    Effect.mapError(persistenceError("decode", scheduleId)),
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
  const drainPermit = yield* Semaphore.make(1);
  const triggerPermit = yield* Semaphore.make(1);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ScheduleListStreamEvent>(),
    PubSub.shutdown,
  );
  const wakes = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);

  const findCommand = (commandId: CommandId) =>
    sql<ScheduleCommandRow>`
      SELECT schedule_id AS "scheduleId", result_sequence AS "resultSequence",
        command_json AS "commandJson"
      FROM schedule_commands
      WHERE command_id = ${commandId}
      LIMIT 1
    `.pipe(Effect.mapError(persistenceError("read command receipt")));

  const findRow = (scheduleId: ScheduleId) =>
    sql<ScheduleRow>`
      SELECT schedule_id AS "scheduleId", record_json AS "recordJson", sequence
      FROM schedule_definitions
      WHERE schedule_id = ${scheduleId}
      LIMIT 1
    `.pipe(Effect.mapError(persistenceError("read", scheduleId)));

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

  const appendEvent = (input: {
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
    );

  const writeDetail = (detail: StoredScheduleDetail, sequence: number) =>
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
    );

  const writeReceipt = (command: ScheduleCommand, sequence: number, acceptedAt: string) =>
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
    );

  const publishUpsert = (detail: StoredScheduleDetail | ScheduleDetail, sequence: number) =>
    PubSub.publish(changes, {
      type: "schedule-upserted",
      sequence,
      schedule: summaryOf(detail, sequence),
    }).pipe(Effect.asVoid);

  const wakeScheduler = PubSub.publish(wakes, undefined).pipe(Effect.asVoid);

  const mutationEvent = (
    command: Exclude<ScheduleCommand, { type: "schedule.delete" | "schedule.run-now" }>,
    detail: StoredScheduleDetail,
  ): ScheduleDomainEvent => {
    switch (command.type) {
      case "schedule.create":
        return { type: "schedule.created", command, definition: detail };
      case "schedule.update":
        return {
          type: "schedule.updated",
          command,
          state: detail.state,
          nextOccurrenceAt: detail.nextOccurrenceAt,
          updatedAt: detail.updatedAt,
        };
      case "schedule.pause":
        return { type: "schedule.paused", command, updatedAt: detail.updatedAt };
      case "schedule.resume":
        return {
          type: "schedule.resumed",
          command,
          nextOccurrenceAt: detail.nextOccurrenceAt,
          updatedAt: detail.updatedAt,
        };
      case "schedule.acknowledge-failures":
        return {
          type: "schedule.failures-acknowledged",
          command,
          updatedAt: detail.updatedAt,
        };
    }
  };

  const validateDefinition = Effect.fn("ScheduleService.validateDefinition")(function* (
    definition: Pick<ScheduleDetail, "id" | "projectId" | "timing" | "timeZone" | "execution">,
    at: string,
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
      try: () => previewScheduleTiming(definition.timing, definition.timeZone, at),
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

  const persistMutation = (input: {
    readonly command: ScheduleCommand;
    readonly previous: StoredScheduleDetail | null;
    readonly detail: StoredScheduleDetail;
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
        if (input.command.type === "schedule.delete" || input.command.type === "schedule.run-now") {
          return yield* Effect.die("Delete and Run now use dedicated persistence paths.");
        }
        const event = mutationEvent(input.command, input.detail);
        const sequence = yield* appendEvent({
          scheduleId: input.detail.id,
          event,
          createdAt: input.at,
        });
        const projected = evolveScheduleDefinition(input.previous, event);
        if (projected === null) {
          return yield* Effect.die("A Schedule mutation unexpectedly deleted its projection.");
        }
        yield* writeDetail(projected, sequence);
        yield* writeReceipt(input.command, sequence, input.at);
        return { sequence, detail: projected };
      }),
    );

  const reserveRunNow = Effect.fn("ScheduleService.reserveRunNow")(function* (
    command: Extract<ScheduleCommand, { type: "schedule.run-now" }>,
    at: string,
  ) {
    const detail = yield* loadStoredDetail(command.scheduleId);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const event = {
            type: "schedule.occurrence-reserved" as const,
            occurrenceId: command.occurrenceId,
            scheduledFor: at,
            source: "manual" as const,
          };
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
      if ((yield* findRow(command.scheduleId))[0] !== undefined) {
        return yield* operationError(
          "already_exists",
          "A Schedule with this identity already exists.",
          command.scheduleId,
        );
      }
      const preview = yield* validateDefinition({ id: command.scheduleId, ...command }, at);
      const detail: StoredScheduleDetail = {
        id: command.scheduleId,
        projectId: command.projectId,
        name: command.name,
        prompt: command.prompt,
        timing: command.timing,
        timeZone: command.timeZone,
        execution: command.execution,
        state: command.state,
        nextOccurrenceAt: command.state === "enabled" ? (preview[0] ?? null) : null,
        latestHistory: null,
        unacknowledgedFailure: false,
        createdAt: at,
        updatedAt: at,
      };
      const persisted = yield* persistMutation({
        command,
        previous: null,
        detail,
        at,
      });
      return { ...persisted, prior: false as const };
    }

    const current = yield* loadStoredDetail(command.scheduleId);
    if (command.type === "schedule.update") {
      const preview = yield* validateDefinition({ id: current.id, ...command }, at);
      const state =
        current.state === "completed" || current.state === "failed" ? "enabled" : current.state;
      const detail: StoredScheduleDetail = {
        ...current,
        projectId: command.projectId,
        name: command.name,
        prompt: command.prompt,
        timing: command.timing,
        timeZone: command.timeZone,
        execution: command.execution,
        state,
        nextOccurrenceAt: state === "enabled" ? (preview[0] ?? null) : null,
        updatedAt: at,
      };
      const persisted = yield* persistMutation({
        command,
        previous: current,
        detail,
        at,
      });
      return { ...persisted, prior: false as const };
    }

    if (command.type === "schedule.delete") {
      const persisted = yield* sql.withTransaction(
        Effect.gen(function* () {
          const event = { type: "schedule.deleted" as const, command };
          const sequence = yield* appendEvent({
            scheduleId: current.id,
            event,
            createdAt: at,
          });
          const projected = evolveScheduleDefinition(current, event);
          if (projected === null) {
            yield* sql`DELETE FROM schedule_definitions WHERE schedule_id = ${current.id}`;
          } else {
            yield* writeDetail(projected, sequence);
          }
          yield* writeReceipt(command, sequence, at);
          return { sequence, detail: null };
        }),
      );
      return { ...persisted, prior: false as const };
    }

    if (command.type === "schedule.run-now") {
      const persisted = yield* reserveRunNow(command, at);
      return { ...persisted, prior: false as const };
    }

    let detail: StoredScheduleDetail;
    if (command.type === "schedule.pause") {
      detail = { ...current, state: "paused", nextOccurrenceAt: null, updatedAt: at };
    } else if (command.type === "schedule.resume") {
      const preview = yield* validateDefinition(current, at);
      detail = {
        ...current,
        state: "enabled",
        nextOccurrenceAt: preview[0] ?? null,
        updatedAt: at,
      };
    } else {
      detail = { ...current, unacknowledgedFailure: false, updatedAt: at };
    }
    const persisted = yield* persistMutation({ command, previous: current, detail, at });
    return { ...persisted, prior: false as const };
  });

  const loadOccurrence = (occurrenceId: OccurrenceId) =>
    sql<ScheduleOccurrenceRow>`
      SELECT occurrence_id AS "occurrenceId", schedule_id AS "scheduleId",
        scheduled_for AS "scheduledFor", source, status, thread_id AS "threadId",
        definition_json AS "definitionJson"
      FROM schedule_occurrences
      WHERE occurrence_id = ${occurrenceId}
      LIMIT 1
    `.pipe(Effect.mapError(persistenceError("read Occurrence")));

  const appendHistoryEntry = Effect.fn("ScheduleService.appendHistoryEntry")(function* (
    scheduleId: ScheduleId,
    entry: ScheduleHistoryEntry,
    at: string,
  ) {
    const latestRows = yield* sql<ScheduleHistoryRow>`
      SELECT history_sequence AS "historySequence", record_json AS "recordJson"
      FROM schedule_history
      WHERE schedule_id = ${scheduleId}
      ORDER BY history_sequence DESC
      LIMIT 1
    `.pipe(Effect.mapError(persistenceError("read latest history", scheduleId)));
    const latestRow = latestRows[0];
    const latest =
      latestRow === undefined
        ? undefined
        : yield* decodeScheduleHistoryEntryJson(latestRow.recordJson).pipe(
            Effect.mapError(persistenceError("decode latest history", scheduleId)),
          );
    const persistedEntry: ScheduleHistoryEntry =
      entry.type === "failed" &&
      latest?.type === "failed" &&
      latest.code === entry.code &&
      latest.message === entry.message
        ? {
            ...entry,
            count: latest.count + 1,
            firstFailedAt: latest.firstFailedAt,
          }
        : entry;
    const recordJson = yield* encodeScheduleHistoryEntryJson(persistedEntry).pipe(
      Effect.mapError(persistenceError("encode history", scheduleId)),
    );
    if (
      persistedEntry.type === "failed" &&
      latest?.type === "failed" &&
      latestRow !== undefined &&
      latest.code === persistedEntry.code &&
      latest.message === persistedEntry.message
    ) {
      yield* sql`
        UPDATE schedule_history
        SET record_json = ${recordJson}, created_at = ${at}
        WHERE history_sequence = ${latestRow.historySequence}
      `.pipe(Effect.mapError(persistenceError("compact history", scheduleId)));
    } else {
      yield* sql`
        INSERT INTO schedule_history (
          schedule_id, kind, failure_code, failure_message, record_json, created_at
        ) VALUES (
          ${scheduleId}, ${persistedEntry.type},
          ${persistedEntry.type === "failed" ? persistedEntry.code : null},
          ${persistedEntry.type === "failed" ? persistedEntry.message : null},
          ${recordJson}, ${at}
        )
      `.pipe(Effect.mapError(persistenceError("append history", scheduleId)));
    }
    return persistedEntry;
  });

  const recordOutcome = Effect.fn("ScheduleService.recordOutcome")(function* (input: {
    readonly occurrence: ScheduleOccurrenceRow;
    readonly type: "triggered" | "failed";
    readonly threadId: ThreadId | null;
    readonly code?: string;
    readonly message?: string;
  }) {
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
    let proposedHistoryEntry: ScheduleHistoryEntry;
    if (input.type === "triggered" && input.threadId !== null) {
      proposedHistoryEntry = {
        type: "triggered",
        occurrenceId,
        scheduledFor: input.occurrence.scheduledFor,
        triggeredAt: at,
        threadId: input.threadId,
      };
    } else {
      const code = input.code ?? "trigger_failed";
      const message = input.message ?? "The Occurrence could not Trigger.";
      proposedHistoryEntry = {
        type: "failed",
        occurrenceId,
        scheduledFor: input.occurrence.scheduledFor,
        failedAt: at,
        code,
        message,
        count: 1,
        firstFailedAt: at,
        lastFailedAt: at,
      };
    }
    const state =
      input.occurrence.source === "manual"
        ? current.state
        : sourceDetail.timing.type === "one-time"
          ? input.type === "triggered"
            ? "completed"
            : "failed"
          : current.state;
    const result = yield* mutationMutex
      .withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            const historyEntry = yield* appendHistoryEntry(scheduleId, proposedHistoryEntry, at);
            const detail: StoredScheduleDetail = {
              ...current,
              state,
              latestHistory: historyEntry,
              unacknowledgedFailure: input.type === "failed" ? true : current.unacknowledgedFailure,
              updatedAt: at,
            };
            if (historyEntry.type === "skipped") {
              return yield* Effect.die("An Occurrence outcome cannot produce skipped history.");
            }
            const event =
              historyEntry.type === "triggered"
                ? {
                    type: "schedule.occurrence-triggered" as const,
                    entry: historyEntry,
                    state: detail.state,
                    unacknowledgedFailure: detail.unacknowledgedFailure,
                    updatedAt: detail.updatedAt,
                  }
                : {
                    type: "schedule.occurrence-failed" as const,
                    entry: historyEntry,
                    state: detail.state,
                    unacknowledgedFailure: detail.unacknowledgedFailure,
                    updatedAt: detail.updatedAt,
                  };
            const eventSequence = yield* appendEvent({
              scheduleId,
              event,
              createdAt: at,
            });
            yield* sql`
            UPDATE schedule_occurrences
            SET status = ${input.type}, thread_id = ${input.threadId},
              error_code = ${input.code ?? null}, error_message = ${input.message ?? null}, updated_at = ${at}
            WHERE occurrence_id = ${occurrenceId}
            `;
            const projected = evolveScheduleDefinition(current, event);
            if (projected === null) {
              return yield* Effect.die("An Occurrence outcome deleted its Schedule projection.");
            }
            yield* writeDetail(projected, eventSequence);
            return { sequence: eventSequence, detail: projected };
          }),
        ),
      )
      .pipe(Effect.mapError(persistenceError("record Occurrence outcome", scheduleId)));
    yield* publishUpsert(result.detail, result.sequence);
  });

  const triggerOccurrence = Effect.fn("ScheduleService.triggerOccurrence")(function* (
    occurrenceId: OccurrenceId,
  ) {
    const occurrenceRows = yield* loadOccurrence(occurrenceId);
    const occurrence = occurrenceRows[0];
    if (
      occurrence === undefined ||
      occurrence.status === "triggered" ||
      occurrence.status === "failed"
    ) {
      return;
    }
    const definition = yield* decodeStoredScheduleDetail(
      occurrence.definitionJson,
      occurrence.scheduleId as ScheduleId,
    );
    const threadId = ThreadId.make(`schedule:${occurrence.occurrenceId}`);
    const existingThread = yield* projection
      .getThreadShellById(threadId)
      .pipe(Effect.mapError(persistenceError("read recovered Thread", definition.id)));
    if (Option.isSome(existingThread) && existingThread.value.latestTurn !== null) {
      yield* recordOutcome({
        occurrence,
        type: "triggered",
        threadId,
      });
      return;
    }
    const cleanupRecoveredThread = Option.isSome(existingThread)
      ? threadBootstrap
          .cleanupRecoveredThread(threadId)
          .pipe(Effect.mapError(persistenceError("clean up recovered Thread", definition.id)))
      : Effect.void;
    const project = yield* projection
      .getProjectShellById(definition.projectId)
      .pipe(Effect.mapError(persistenceError("read target Project", definition.id)));
    if (Option.isNone(project)) {
      yield* cleanupRecoveredThread;
      yield* recordOutcome({
        occurrence,
        type: "failed",
        threadId: null,
        code: "project_not_found",
        message: "The target Project no longer exists.",
      });
      return;
    }
    const providers = yield* providerRegistry.getProviders;
    const selectedProvider = providers.find(
      ({ instanceId }) => instanceId === definition.execution.modelSelection.instanceId,
    );
    if (
      selectedProvider === undefined ||
      !selectedProvider.enabled ||
      !selectedProvider.installed ||
      !isProviderAvailable(selectedProvider) ||
      selectedProvider.status === "disabled" ||
      selectedProvider.status === "error" ||
      selectedProvider.auth.status === "unauthenticated"
    ) {
      yield* cleanupRecoveredThread;
      yield* recordOutcome({
        occurrence,
        type: "failed",
        threadId: null,
        code: "provider_unavailable",
        message: "The configured provider is unavailable or disabled.",
      });
      return;
    }
    if (
      !selectedProvider.models.some(
        ({ slug }) => slug === definition.execution.modelSelection.model,
      )
    ) {
      yield* cleanupRecoveredThread;
      yield* recordOutcome({
        occurrence,
        type: "failed",
        threadId: null,
        code: "model_unavailable",
        message: "The configured model is no longer available from this provider.",
      });
      return;
    }
    const at = yield* nowIso;
    yield* sql`
      UPDATE schedule_occurrences
      SET status = 'triggering', thread_id = ${threadId}, updated_at = ${at}
      WHERE occurrence_id = ${occurrenceId} AND status IN ('pending', 'triggering')
    `.pipe(Effect.mapError(persistenceError("claim Occurrence", definition.id)));
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
    const command = {
      type: "thread.turn.start" as const,
      commandId: CommandId.make(`schedule:${occurrence.occurrenceId}:trigger`),
      threadId,
      message: {
        messageId: MessageId.make(`schedule:${occurrence.occurrenceId}:message`),
        role: "user" as const,
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
    yield* threadBootstrap.bootstrapTurnStart(command).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          recordOutcome({
            occurrence: { ...occurrence, threadId },
            type: "failed",
            threadId: null,
            code: "thread_bootstrap_rejected",
            message: error.message,
          }),
        onSuccess: () =>
          recordOutcome({
            occurrence: { ...occurrence, threadId },
            type: "triggered",
            threadId,
          }),
      }),
    );
  });

  const failInvalidDueSchedule = Effect.fn("ScheduleService.failInvalidDueSchedule")(function* (
    detail: StoredScheduleDetail,
    at: string,
    cause: unknown,
  ) {
    const occurrenceId = OccurrenceId.make(
      yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(persistenceError("reserve invalid Occurrence identity", detail.id)),
      ),
    );
    const scheduledFor = detail.nextOccurrenceAt ?? at;
    const message =
      cause instanceof Error ? cause.message : "The saved Schedule timing is invalid.";
    const historyEntry = {
      type: "failed" as const,
      occurrenceId,
      scheduledFor,
      failedAt: at,
      code: "invalid_timing",
      message,
      count: 1,
      firstFailedAt: at,
      lastFailedAt: at,
    };
    const nextDetail: StoredScheduleDetail = {
      ...detail,
      state: "failed",
      nextOccurrenceAt: null,
      latestHistory: historyEntry,
      unacknowledgedFailure: true,
      updatedAt: at,
    };
    const event = {
      type: "schedule.occurrence-failed" as const,
      entry: historyEntry,
      state: nextDetail.state,
      nextOccurrenceAt: nextDetail.nextOccurrenceAt,
      unacknowledgedFailure: true,
      updatedAt: at,
    };
    const result = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* appendHistoryEntry(detail.id, historyEntry, at);
          const sequence = yield* appendEvent({ scheduleId: detail.id, event, createdAt: at });
          const definitionJson = yield* encodeStoredScheduleDetailJson(detail).pipe(
            Effect.mapError(persistenceError("encode invalid due Occurrence", detail.id)),
          );
          yield* sql`
          INSERT INTO schedule_occurrences (
            occurrence_id, schedule_id, scheduled_for, source, status, thread_id,
            definition_json, error_code, error_message, created_at, updated_at
          ) VALUES (
            ${occurrenceId}, ${detail.id}, ${scheduledFor}, 'scheduled', 'failed', NULL,
            ${definitionJson}, 'invalid_timing', ${message}, ${at}, ${at}
          )
        `;
          const projected = evolveScheduleDefinition(detail, event);
          if (projected === null) {
            return yield* Effect.die("Invalid timing failure deleted its Schedule projection.");
          }
          yield* writeDetail(projected, sequence);
          return { sequence, detail: projected };
        }),
      )
      .pipe(Effect.mapError(persistenceError("fail invalid due Schedule", detail.id)));
    yield* publishUpsert(result.detail, result.sequence);
  });

  const reserveDueBatch = Effect.fn("ScheduleService.reserveDueBatch")(function* () {
    const at = yield* nowIso;
    const rows = yield* sql<ScheduleRow>`
      SELECT schedule_id AS "scheduleId", record_json AS "recordJson", sequence
      FROM schedule_definitions
      WHERE state = 'enabled' AND next_occurrence_at IS NOT NULL AND next_occurrence_at <= ${at}
      ORDER BY next_occurrence_at ASC, created_at ASC, schedule_id ASC
      LIMIT ${DUE_RESERVATION_BATCH_SIZE}
    `.pipe(Effect.mapError(persistenceError("read due Schedules")));
    const dueSchedules = yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const detail = yield* decodeStoredScheduleDetail(
          row.recordJson,
          row.scheduleId as ScheduleId,
        );
        if (detail.nextOccurrenceAt === null) return Option.none();
        const due = yield* Effect.result(
          Effect.try({
            try: () =>
              latestScheduleOccurrenceAtOrBefore(
                detail.timing,
                detail.timeZone,
                detail.nextOccurrenceAt as string,
                at,
              ),
            catch: (cause) =>
              operationError(
                "invalid_timing",
                "The saved Schedule timing is invalid.",
                detail.id,
                cause,
              ),
          }),
        );
        if (Result.isFailure(due)) {
          yield* failInvalidDueSchedule(detail, at, due.failure);
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
        const occurrenceId = OccurrenceId.make(
          yield* crypto.randomUUIDv4.pipe(
            Effect.mapError(persistenceError("reserve Occurrence identity", detail.id)),
          ),
        );
        const skippedHistory: ScheduleHistoryEntry | null =
          due.skipped === null
            ? null
            : {
                type: "skipped",
                count: due.skipped.count,
                countIsLowerBound: due.skipped.countIsLowerBound,
                firstScheduledFor: due.skipped.firstScheduledFor,
                lastScheduledFor: due.skipped.lastScheduledFor,
                recordedAt: at,
              };
        const nextDetail: StoredScheduleDetail = {
          ...detail,
          nextOccurrenceAt: due.nextOccurrenceAt,
          latestHistory: skippedHistory ?? detail.latestHistory,
          updatedAt: at,
        };
        const reservation = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              let projected: StoredScheduleDetail = detail;
              if (skippedHistory !== null) {
                yield* appendHistoryEntry(detail.id, skippedHistory, at);
                const skippedEvent = {
                  type: "schedule.occurrences-skipped" as const,
                  entry: skippedHistory,
                  updatedAt: at,
                };
                yield* appendEvent({
                  scheduleId: detail.id,
                  event: skippedEvent,
                  createdAt: at,
                });
                const afterSkipped = evolveScheduleDefinition(projected, skippedEvent);
                if (afterSkipped === null) {
                  return yield* Effect.die("Skipped history deleted its Schedule projection.");
                }
                projected = afterSkipped;
              }
              const event = {
                type: "schedule.occurrence-reserved" as const,
                occurrenceId,
                scheduledFor: due.scheduledFor,
                source: "scheduled" as const,
                nextOccurrenceAt: nextDetail.nextOccurrenceAt,
                updatedAt: nextDetail.updatedAt,
              };
              const eventSequence = yield* appendEvent({
                scheduleId: detail.id,
                event,
                createdAt: at,
              });
              const definitionJson = yield* encodeStoredScheduleDetailJson(detail).pipe(
                Effect.mapError(persistenceError("encode due Occurrence", detail.id)),
              );
              yield* sql`
          INSERT INTO schedule_occurrences (
            occurrence_id, schedule_id, scheduled_for, source, status, thread_id,
            definition_json, created_at, updated_at
          ) VALUES (
            ${occurrenceId}, ${detail.id}, ${due.scheduledFor}, 'scheduled', 'pending', NULL,
            ${definitionJson}, ${at}, ${at}
          )
        `;
              const afterReservation = evolveScheduleDefinition(projected, event);
              if (afterReservation === null) {
                return yield* Effect.die("A reservation deleted its Schedule projection.");
              }
              yield* writeDetail(afterReservation, eventSequence);
              return { sequence: eventSequence, detail: afterReservation };
            }),
          )
          .pipe(Effect.mapError(persistenceError("reserve due Occurrence", detail.id)));
        yield* publishUpsert(reservation.detail, reservation.sequence);
        return occurrenceId;
      }),
    );
    return rows.length;
  });

  const nextPendingOccurrence = () =>
    sql<{ readonly occurrenceId: string; readonly scheduledFor: string }>`
      SELECT occurrence_id AS "occurrenceId", scheduled_for AS "scheduledFor"
      FROM schedule_occurrences
      WHERE status IN ('pending', 'triggering')
      ORDER BY scheduled_for ASC, created_at ASC, occurrence_id ASC
      LIMIT 1
    `.pipe(Effect.mapError(persistenceError("read pending Occurrences")));

  const nextDueAt = () =>
    sql<{ readonly nextOccurrenceAt: string | null }>`
      SELECT next_occurrence_at AS "nextOccurrenceAt"
      FROM schedule_definitions
      WHERE state = 'enabled' AND next_occurrence_at IS NOT NULL
      ORDER BY next_occurrence_at ASC, created_at ASC, schedule_id ASC
      LIMIT 1
    `.pipe(
      Effect.map((rows) => rows[0]?.nextOccurrenceAt ?? null),
      Effect.mapError(persistenceError("read next due Schedule")),
    );

  const drainDue: ScheduleServiceShape["drainDue"] = drainPermit.withPermits(1)(
    Effect.gen(function* () {
      while (true) {
        const processed = yield* mutationMutex.withPermits(1)(reserveDueBatch());
        const unseenDueAt = yield* nextDueAt();
        let triggered = 0;
        while (triggered < DUE_RESERVATION_BATCH_SIZE) {
          const pending = (yield* nextPendingOccurrence())[0];
          // An unreserved Schedule cannot retain an Occurrence older than its
          // current next_occurrence_at. Pending work strictly before that
          // frontier is therefore globally safe to Trigger without scanning
          // the rest of the backlog first.
          if (
            pending === undefined ||
            (unseenDueAt !== null && pending.scheduledFor >= unseenDueAt)
          ) {
            break;
          }
          yield* triggerPermit.withPermits(1)(
            triggerOccurrence(pending.occurrenceId as OccurrenceId),
          );
          triggered += 1;
        }
        if (processed === 0 && triggered === 0) return;
        // Reservation holds the mutation mutex for one bounded page and each
        // Trigger holds its permit independently. Yield so queued commands can
        // acquire those permits before the next page.
        yield* Effect.yieldNow;
      }
    }).pipe(Effect.withSpan("ScheduleService.drainDue")),
  );

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
      yield* wakeScheduler;
    }
    if (command.type === "schedule.run-now") {
      yield* triggerOccurrence(command.occurrenceId);
    }
    return {
      sequence: mutation.sequence,
      scheduleId: mutation.prior ? mutation.scheduleId : command.scheduleId,
    };
  });
  const dispatch: ScheduleServiceShape["dispatch"] = (command) =>
    triggerPermit.withPermits(1)(dispatchUnlocked(command));

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

  const runScheduler = Effect.scoped(
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
        const next = yield* nextDueAt().pipe(
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
