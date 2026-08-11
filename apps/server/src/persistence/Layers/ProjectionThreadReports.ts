import { SessionReportArtifact } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

import {
  DeleteProjectionThreadReportsInput,
  ListProjectionThreadReportsInput,
  ProjectionThreadReport,
  ProjectionThreadReportRepository,
  type ProjectionThreadReportRepositoryShape,
} from "../Services/ProjectionThreadReports.ts";

const ProjectionThreadReportDbRowSchema = ProjectionThreadReport.mapFields(
  Struct.assign({
    artifacts: Schema.fromJsonString(Schema.Array(SessionReportArtifact)),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionThreadReportRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadReportRow = SqlSchema.void({
    Request: ProjectionThreadReport,
    execute: (row) => sql`
      INSERT INTO projection_thread_reports (
        report_id,
        thread_id,
        status,
        title,
        summary,
        artifacts_json,
        created_at
      )
      VALUES (
        ${row.reportId},
        ${row.threadId},
        ${row.status},
        ${row.title},
        ${row.summary},
        ${JSON.stringify(row.artifacts)},
        ${row.createdAt}
      )
      ON CONFLICT (report_id)
      DO UPDATE SET
        thread_id = excluded.thread_id,
        status = excluded.status,
        title = excluded.title,
        summary = excluded.summary,
        artifacts_json = excluded.artifacts_json,
        created_at = excluded.created_at
    `,
  });

  const listProjectionThreadReportRows = SqlSchema.findAll({
    Request: ListProjectionThreadReportsInput,
    Result: ProjectionThreadReportDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        report_id AS "reportId",
        thread_id AS "threadId",
        status,
        title,
        summary,
        artifacts_json AS "artifacts",
        created_at AS "createdAt"
      FROM projection_thread_reports
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, report_id ASC
    `,
  });

  const deleteProjectionThreadReportRows = SqlSchema.void({
    Request: DeleteProjectionThreadReportsInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_reports
      WHERE thread_id = ${threadId}
    `,
  });

  const upsert: ProjectionThreadReportRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadReportRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadReportRepository.upsert:query",
          "ProjectionThreadReportRepository.upsert:encodeRequest",
        ),
      ),
    );

  const listByThreadId: ProjectionThreadReportRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadReportRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadReportRepository.listByThreadId:query",
          "ProjectionThreadReportRepository.listByThreadId:decodeRows",
        ),
      ),
    );

  const deleteByThreadId: ProjectionThreadReportRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadReportRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadReportRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadReportRepositoryShape;
});

export const ProjectionThreadReportRepositoryLive = Layer.effect(
  ProjectionThreadReportRepository,
  makeProjectionThreadReportRepository,
);
