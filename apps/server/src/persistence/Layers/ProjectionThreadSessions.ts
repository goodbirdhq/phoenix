import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceSqlError } from "../Errors.ts";

import {
  ProjectionThreadSession,
  ProjectionThreadSessionRepository,
  type ProjectionThreadSessionRepositoryShape,
  DeleteProjectionThreadSessionInput,
  GetProjectionThreadSessionInput,
} from "../Services/ProjectionThreadSessions.ts";

const ProjectionThreadSessionDbRow = ProjectionThreadSession.mapFields(
  Struct.assign({ interruptedToolCall: Schema.BooleanFromBit }),
);

const makeProjectionThreadSessionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadSessionRow = SqlSchema.void({
    Request: ProjectionThreadSession,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_instance_id,
          runtime_mode,
          active_turn_id,
          last_error,
          last_error_kind,
          stopped_by,
          stop_requested_at,
          stop_reason,
          interrupted_tool_call,
          last_completed_operation,
          grace_stop_deadline_at,
          grace_stop_episode_id,
          episode_started_at,
          queued_delivery_message_id,
          updated_at
        )
        VALUES (
          ${row.threadId},
          ${row.status},
          ${row.providerName},
          ${row.providerInstanceId},
          ${row.runtimeMode},
          ${row.activeTurnId},
          ${row.lastError},
          ${row.lastErrorKind},
          ${row.stoppedBy},
          ${row.stopRequestedAt},
          ${row.stopReason},
          ${row.interruptedToolCall ? 1 : 0},
          ${row.lastCompletedOperation},
          ${row.graceStopDeadlineAt},
          ${row.graceStopEpisodeId},
          ${row.episodeStartedAt},
          ${row.queuedDeliveryMessageId},
          ${row.updatedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          status = excluded.status,
          provider_name = excluded.provider_name,
          provider_instance_id = excluded.provider_instance_id,
          runtime_mode = excluded.runtime_mode,
          active_turn_id = excluded.active_turn_id,
          last_error = excluded.last_error,
          last_error_kind = excluded.last_error_kind,
          stopped_by = excluded.stopped_by,
          stop_requested_at = excluded.stop_requested_at,
          stop_reason = excluded.stop_reason,
          interrupted_tool_call = excluded.interrupted_tool_call,
          last_completed_operation = excluded.last_completed_operation,
          grace_stop_deadline_at = excluded.grace_stop_deadline_at,
          grace_stop_episode_id = excluded.grace_stop_episode_id,
          episode_started_at = excluded.episode_started_at,
          queued_delivery_message_id = excluded.queued_delivery_message_id,
          updated_at = excluded.updated_at
      `,
  });

  const getProjectionThreadSessionRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadSessionInput,
    Result: ProjectionThreadSessionDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          last_error_kind AS "lastErrorKind",
          stopped_by AS "stoppedBy",
          stop_requested_at AS "stopRequestedAt",
          stop_reason AS "stopReason",
          interrupted_tool_call AS "interruptedToolCall",
          last_completed_operation AS "lastCompletedOperation",
          grace_stop_deadline_at AS "graceStopDeadlineAt",
          grace_stop_episode_id AS "graceStopEpisodeId",
          episode_started_at AS "episodeStartedAt",
          queued_delivery_message_id AS "queuedDeliveryMessageId",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `,
  });

  const deleteProjectionThreadSessionRow = SqlSchema.void({
    Request: DeleteProjectionThreadSessionInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadSessionRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadSessionRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadSessionRepository.upsert:query")),
    );

  const getByThreadId: ProjectionThreadSessionRepositoryShape["getByThreadId"] = (input) =>
    getProjectionThreadSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.getByThreadId:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadSessionRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadSessionRepositoryShape;
});

export const ProjectionThreadSessionRepositoryLive = Layer.effect(
  ProjectionThreadSessionRepository,
  makeProjectionThreadSessionRepository,
);
