import { OrchestrationCheckpointFile } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  CancelProjectionQueuedTurnInput,
  ClearCheckpointTurnConflictInput,
  ConsumeProjectionQueuedTurnInput,
  DeleteProjectionQueuedTurnStartInput,
  DeleteProjectionTurnsByThreadInput,
  GetProjectionPendingTurnStartInput,
  GetQueuedDeliveryDiagnosticsInput,
  GetProjectionTurnByTurnIdInput,
  ListProjectionTurnsByThreadInput,
  ListQueuedDeliveryReceiptsInput,
  MarkProjectionQueuedTurnReleasingInput,
  ProjectionPendingTurnStart,
  ProjectionQueuedDeliveryReceipt,
  ProjectionQueuedDeliveryDiagnostics,
  ProjectionQueuedTurnStart,
  ProjectionTurn,
  RequeueProjectionQueuedTurnInput,
  ProjectionTurnById,
  ProjectionTurnRepository,
  type ProjectionTurnRepositoryShape,
} from "../Services/ProjectionTurns.ts";

const ProjectionTurnDbRowSchema = ProjectionTurn.mapFields(
  Struct.assign({
    checkpointFiles: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);

const ProjectionTurnByIdDbRowSchema = ProjectionTurnById.mapFields(
  Struct.assign({
    checkpointFiles: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionTurnRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionTurnById = SqlSchema.void({
    Request: ProjectionTurnByIdDbRowSchema,
    execute: (row) =>
      sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          ${row.threadId},
          ${row.turnId},
          ${row.pendingMessageId},
          ${row.sourceProposedPlanThreadId},
          ${row.sourceProposedPlanId},
          ${row.assistantMessageId},
          ${row.state},
          ${row.requestedAt},
          ${row.startedAt},
          ${row.completedAt},
          ${row.checkpointTurnCount},
          ${row.checkpointRef},
          ${row.checkpointStatus},
          ${row.checkpointFiles}
        )
        ON CONFLICT (thread_id, turn_id)
        DO UPDATE SET
          pending_message_id = excluded.pending_message_id,
          source_proposed_plan_thread_id = excluded.source_proposed_plan_thread_id,
          source_proposed_plan_id = excluded.source_proposed_plan_id,
          assistant_message_id = excluded.assistant_message_id,
          state = excluded.state,
          requested_at = excluded.requested_at,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          checkpoint_turn_count = excluded.checkpoint_turn_count,
          checkpoint_ref = excluded.checkpoint_ref,
          checkpoint_status = excluded.checkpoint_status,
          checkpoint_files_json = excluded.checkpoint_files_json
      `,
  });

  const clearPendingProjectionTurnsByThread = SqlSchema.void({
    Request: DeleteProjectionTurnsByThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
          AND checkpoint_turn_count IS NULL
      `,
  });

  const insertPendingProjectionTurn = SqlSchema.void({
    Request: ProjectionPendingTurnStart,
    execute: (row) =>
      sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          ${row.threadId},
          NULL,
          ${row.messageId},
          ${row.sourceProposedPlanThreadId},
          ${row.sourceProposedPlanId},
          NULL,
          'pending',
          ${row.requestedAt},
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `,
  });

  const getPendingProjectionTurn = SqlSchema.findOneOption({
    Request: GetProjectionPendingTurnStartInput,
    Result: ProjectionPendingTurnStart,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          pending_message_id AS "messageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          requested_at AS "requestedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
          AND pending_message_id IS NOT NULL
          AND checkpoint_turn_count IS NULL
        ORDER BY requested_at DESC
        LIMIT 1
      `,
  });

  const insertQueuedProjectionTurn = SqlSchema.void({
    Request: ProjectionQueuedTurnStart,
    execute: (row) =>
      sql`
        DELETE FROM projection_turns
        WHERE thread_id = ${row.threadId}
          AND pending_message_id = ${row.messageId}
          AND state IN ('queued', 'interrupting', 'releasing')
      `.pipe(
        Effect.andThen(sql`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id,
            source_proposed_plan_id, assistant_message_id, state, requested_at,
            releasing_at, started_at, completed_at, checkpoint_turn_count, checkpoint_ref,
            checkpoint_status, checkpoint_files_json
          ) VALUES (
            ${row.threadId}, NULL, ${row.messageId}, NULL,
            NULL, NULL, ${row.mode === "interrupt" ? "interrupting" : "queued"}, ${row.requestedAt},
            NULL, NULL, NULL, NULL, NULL, NULL, '[]'
          )
        `),
      ),
  });

  const markQueuedProjectionTurnReleasing = SqlSchema.void({
    Request: MarkProjectionQueuedTurnReleasingInput,
    execute: ({ threadId, messageId, releasingAt }) =>
      sql`
        UPDATE projection_turns
        SET state = 'releasing', releasing_at = ${releasingAt}
        WHERE thread_id = ${threadId}
          AND pending_message_id = ${messageId}
          AND state IN ('queued', 'interrupting')
      `,
  });

  const consumeQueuedProjectionTurn = SqlSchema.void({
    Request: ConsumeProjectionQueuedTurnInput,
    execute: ({ threadId, messageId, turnId, consumedAt }) =>
      sql`
        UPDATE projection_turns
        SET state = 'consumed', consumed_by_turn_id = ${turnId}, consumed_at = ${consumedAt},
            cancelled_at = NULL, cancel_reason = NULL
        WHERE thread_id = ${threadId}
          AND pending_message_id = ${messageId}
          AND state IN ('releasing', 'cancelled')
          AND releasing_at IS NOT NULL
      `,
  });

  const cancelQueuedProjectionTurn = SqlSchema.void({
    Request: CancelProjectionQueuedTurnInput,
    execute: ({ threadId, messageId, reason, cancelledAt }) =>
      sql`
        UPDATE projection_turns
        SET state = 'cancelled', cancelled_at = ${cancelledAt}, cancel_reason = ${reason}
        WHERE thread_id = ${threadId}
          AND pending_message_id = ${messageId}
          AND state IN ('queued', 'interrupting', 'releasing')
      `,
  });

  const requeueQueuedProjectionTurn = SqlSchema.void({
    Request: RequeueProjectionQueuedTurnInput,
    execute: ({ threadId, messageId }) =>
      sql`
        UPDATE projection_turns
        SET state = 'queued', releasing_at = NULL, redelivery_count = redelivery_count + 1,
            consumed_by_turn_id = NULL, consumed_at = NULL,
            cancelled_at = NULL, cancel_reason = NULL
        WHERE thread_id = ${threadId}
          AND pending_message_id = ${messageId}
          AND state = 'releasing'
      `,
  });

  const deleteQueuedProjectionTurn = SqlSchema.void({
    Request: DeleteProjectionQueuedTurnStartInput,
    execute: ({ threadId, messageId }) =>
      sql`
        DELETE FROM projection_turns
        WHERE thread_id = ${threadId}
          AND pending_message_id = ${messageId}
          AND state IN ('queued', 'interrupting', 'releasing')
      `,
  });

  const listQueuedProjectionTurns = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionQueuedTurnStart,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          pending_message_id AS "messageId",
          CASE WHEN state = 'interrupting' THEN 'interrupt' ELSE 'queue' END AS mode,
          CASE WHEN state = 'releasing' THEN 'releasing' ELSE 'queued' END AS state,
          requested_at AS "requestedAt",
          releasing_at AS "releasingAt",
          redelivery_count AS "redeliveryCount"
        FROM projection_turns
        WHERE state IN ('queued', 'interrupting', 'releasing')
          AND pending_message_id IS NOT NULL
        ORDER BY requested_at ASC, row_id ASC
      `,
  });

  const listQueuedDeliveryReceiptRows = SqlSchema.findAll({
    Request: ListQueuedDeliveryReceiptsInput,
    Result: ProjectionQueuedDeliveryReceipt,
    execute: ({ threadId, limit }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          pending_message_id AS "messageId",
          CASE
            WHEN state IN ('queued', 'interrupting') THEN 'queued'
            WHEN state = 'releasing' THEN 'releasing'
            ELSE state
          END AS state,
          requested_at AS "requestedAt",
          releasing_at AS "releasingAt",
          redelivery_count AS "redeliveryCount",
          consumed_by_turn_id AS "consumedByTurnId",
          consumed_at AS "consumedAt",
          cancelled_at AS "cancelledAt",
          cancel_reason AS "cancelledReason"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND state IN ('queued', 'interrupting', 'releasing', 'consumed', 'cancelled')
          AND pending_message_id IS NOT NULL
        ORDER BY COALESCE(cancelled_at, consumed_at, requested_at) DESC, row_id DESC
        LIMIT ${limit}
      `,
  });

  const getQueuedDeliveryDiagnosticsRow = SqlSchema.findOne({
    Request: GetQueuedDeliveryDiagnosticsInput,
    Result: ProjectionQueuedDeliveryDiagnostics,
    execute: ({ threadId }) =>
      sql`
        SELECT
          COUNT(*) FILTER (WHERE state IN ('queued', 'interrupting')) AS "pendingQueuedCount",
          COUNT(*) FILTER (WHERE state = 'releasing') AS "stalledDeliveryCount",
          MIN(requested_at) FILTER (
            WHERE state IN ('queued', 'interrupting', 'releasing')
          ) AS "oldestUndeliveredMessageAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND pending_message_id IS NOT NULL
      `,
  });

  const listProjectionTurnsByThread = SqlSchema.findAll({
    Request: ListProjectionTurnsByThreadInput,
    Result: ProjectionTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          pending_message_id AS "pendingMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          assistant_message_id AS "assistantMessageId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "checkpointStatus",
          checkpoint_files_json AS "checkpointFiles"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND state NOT IN ('queued', 'interrupting', 'releasing', 'consumed', 'cancelled')
        ORDER BY
          CASE
            WHEN checkpoint_turn_count IS NULL THEN 1
            ELSE 0
          END ASC,
          checkpoint_turn_count ASC,
          requested_at ASC,
          turn_id ASC
      `,
  });

  const getProjectionTurnByTurnId = SqlSchema.findOneOption({
    Request: GetProjectionTurnByTurnIdInput,
    Result: ProjectionTurnByIdDbRowSchema,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          pending_message_id AS "pendingMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          assistant_message_id AS "assistantMessageId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "checkpointStatus",
          checkpoint_files_json AS "checkpointFiles"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
        LIMIT 1
      `,
  });

  const clearCheckpointTurnConflictRow = SqlSchema.void({
    Request: ClearCheckpointTurnConflictInput,
    execute: ({ threadId, turnId, checkpointTurnCount }) =>
      sql`
        UPDATE projection_turns
        SET
          checkpoint_turn_count = NULL,
          checkpoint_ref = NULL,
          checkpoint_status = NULL,
          checkpoint_files_json = '[]'
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count = ${checkpointTurnCount}
          AND (turn_id IS NULL OR turn_id <> ${turnId})
      `,
  });

  const deleteProjectionTurnsByThread = SqlSchema.void({
    Request: DeleteProjectionTurnsByThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_turns
        WHERE thread_id = ${threadId}
      `,
  });

  const upsertByTurnId: ProjectionTurnRepositoryShape["upsertByTurnId"] = (row) =>
    upsertProjectionTurnById(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.upsertByTurnId:query",
          "ProjectionTurnRepository.upsertByTurnId:encodeRequest",
        ),
      ),
    );

  const replacePendingTurnStart: ProjectionTurnRepositoryShape["replacePendingTurnStart"] = (row) =>
    sql
      .withTransaction(
        clearPendingProjectionTurnsByThread({ threadId: row.threadId }).pipe(
          Effect.flatMap(() => insertPendingProjectionTurn(row)),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionTurnRepository.replacePendingTurnStart:query",
            "ProjectionTurnRepository.replacePendingTurnStart:encodeRequest",
          ),
        ),
      );

  const getPendingTurnStartByThreadId: ProjectionTurnRepositoryShape["getPendingTurnStartByThreadId"] =
    (input) =>
      getPendingProjectionTurn(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.getPendingTurnStartByThreadId:query"),
        ),
      );

  const deletePendingTurnStartByThreadId: ProjectionTurnRepositoryShape["deletePendingTurnStartByThreadId"] =
    (input) =>
      clearPendingProjectionTurnsByThread(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.deletePendingTurnStartByThreadId:query"),
        ),
      );

  const enqueueTurnStart: ProjectionTurnRepositoryShape["enqueueTurnStart"] = (row) =>
    insertQueuedProjectionTurn(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTurnRepository.enqueueTurnStart:query")),
    );

  const markQueuedTurnStartReleasing: ProjectionTurnRepositoryShape["markQueuedTurnStartReleasing"] =
    (input) =>
      markQueuedProjectionTurnReleasing(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.markQueuedTurnStartReleasing:query"),
        ),
      );

  const consumeQueuedTurnStart: ProjectionTurnRepositoryShape["consumeQueuedTurnStart"] = (input) =>
    consumeQueuedProjectionTurn(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionTurnRepository.consumeQueuedTurnStart:query"),
      ),
    );

  const cancelQueuedTurnStart: ProjectionTurnRepositoryShape["cancelQueuedTurnStart"] = (input) =>
    cancelQueuedProjectionTurn(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionTurnRepository.cancelQueuedTurnStart:query"),
      ),
    );

  const requeueQueuedTurnStart: ProjectionTurnRepositoryShape["requeueQueuedTurnStart"] = (input) =>
    requeueQueuedProjectionTurn(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionTurnRepository.requeueQueuedTurnStart:query"),
      ),
    );

  const deleteQueuedTurnStart: ProjectionTurnRepositoryShape["deleteQueuedTurnStart"] = (input) =>
    deleteQueuedProjectionTurn(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionTurnRepository.deleteQueuedTurnStart:query"),
      ),
    );

  const listQueuedTurnStarts: ProjectionTurnRepositoryShape["listQueuedTurnStarts"] =
    listQueuedProjectionTurns().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.listQueuedTurnStarts:query",
          "ProjectionTurnRepository.listQueuedTurnStarts:decodeRows",
        ),
      ),
    );

  const listQueuedDeliveryReceipts: ProjectionTurnRepositoryShape["listQueuedDeliveryReceipts"] = (
    input,
  ) =>
    listQueuedDeliveryReceiptRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.listQueuedDeliveryReceipts:query",
          "ProjectionTurnRepository.listQueuedDeliveryReceipts:decodeRows",
        ),
      ),
    );

  const getQueuedDeliveryDiagnostics: ProjectionTurnRepositoryShape["getQueuedDeliveryDiagnostics"] =
    (input) =>
      getQueuedDeliveryDiagnosticsRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.getQueuedDeliveryDiagnostics:query"),
        ),
      );

  const listByThreadId: ProjectionTurnRepositoryShape["listByThreadId"] = (input) =>
    listProjectionTurnsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.listByThreadId:query",
          "ProjectionTurnRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionTurn>>),
    );

  const getByTurnId: ProjectionTurnRepositoryShape["getByTurnId"] = (input) =>
    getProjectionTurnByTurnId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.getByTurnId:query",
          "ProjectionTurnRepository.getByTurnId:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            Effect.succeed(Option.some(row as Schema.Schema.Type<typeof ProjectionTurnById>)),
        }),
      ),
    );

  const clearCheckpointTurnConflict: ProjectionTurnRepositoryShape["clearCheckpointTurnConflict"] =
    (input) =>
      clearCheckpointTurnConflictRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.clearCheckpointTurnConflict:query"),
        ),
      );

  const deleteByThreadId: ProjectionTurnRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionTurnsByThread(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTurnRepository.deleteByThreadId:query")),
    );

  return {
    upsertByTurnId,
    replacePendingTurnStart,
    getPendingTurnStartByThreadId,
    deletePendingTurnStartByThreadId,
    enqueueTurnStart,
    markQueuedTurnStartReleasing,
    consumeQueuedTurnStart,
    cancelQueuedTurnStart,
    requeueQueuedTurnStart,
    deleteQueuedTurnStart,
    listQueuedTurnStarts,
    listQueuedDeliveryReceipts,
    getQueuedDeliveryDiagnostics,
    listByThreadId,
    getByTurnId,
    clearCheckpointTurnConflict,
    deleteByThreadId,
  } satisfies ProjectionTurnRepositoryShape;
});

export const ProjectionTurnRepositoryLive = Layer.effect(
  ProjectionTurnRepository,
  makeProjectionTurnRepository,
);
