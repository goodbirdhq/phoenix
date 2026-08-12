import {
  IsoDateTime,
  SessionReportArtifact,
  SessionReportOrigin,
  SessionReportStatus,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import { decodeStructuredReportFields } from "../decodeStructuredReportFields.ts";

import {
  DeleteProjectionThreadReportsInput,
  FindProjectionThreadReportInput,
  ListProjectionThreadReportsInput,
  ProjectionThreadReport,
  ProjectionThreadReportRepository,
  type ProjectionThreadReportRepositoryShape,
} from "../Services/ProjectionThreadReports.ts";

const ProjectionThreadReportDbRowSchema = Schema.Struct({
  reportId: TrimmedNonEmptyString,
  threadId: ThreadId,
  status: SessionReportStatus,
  title: TrimmedNonEmptyString,
  summary: Schema.String,
  abstract: Schema.NullOr(Schema.String),
  artifacts: Schema.fromJsonString(Schema.Array(SessionReportArtifact)),
  // Optional findings/validation/recommendation/completionPercent, stored
  // together as one JSON column. Decoded leniently (see
  // decodeStructuredReportFields) rather than through the schema, so a
  // malformed blob can never fail the whole row.
  structuredJson: Schema.NullOr(Schema.String),
  origin: SessionReportOrigin,
  supersedesReportId: Schema.NullOr(TrimmedNonEmptyString),
  // Resolved by the reverse-link subquery every read path shares; NULL when
  // no later report amends this one.
  supersededByReportId: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

// Every read path selects the reverse amendment link with the same
// correlated subquery (repeated inline because a shared string would become a
// bound parameter, not SQL): the earliest report naming this one as its
// predecessor. Two rows could in principle name the same predecessor (a
// retried amendment), and taking the earliest keeps the chain a caller walks
// stable instead of scan-order dependent.

// Single row→report mapping shared by every read path (list and by-id), so a
// column added here can never be silently dropped by one of them.
function mapReportRow(
  row: Schema.Schema.Type<typeof ProjectionThreadReportDbRowSchema>,
): ProjectionThreadReport {
  return {
    reportId: row.reportId,
    threadId: row.threadId,
    status: row.status,
    title: row.title,
    summary: row.summary,
    abstract: row.abstract,
    artifacts: row.artifacts,
    origin: row.origin,
    supersedesReportId: row.supersedesReportId,
    ...(row.supersededByReportId !== null
      ? { supersededByReportId: row.supersededByReportId }
      : {}),
    ...decodeStructuredReportFields(row.structuredJson),
    createdAt: row.createdAt,
  };
}

function encodeStructured(
  report: Pick<
    ProjectionThreadReport,
    "findings" | "validation" | "recommendation" | "completionPercent" | "usage"
  >,
): string | null {
  if (
    report.findings === undefined &&
    report.validation === undefined &&
    report.recommendation === undefined &&
    report.completionPercent === undefined &&
    report.usage === undefined
  ) {
    return null;
  }
  return JSON.stringify({
    ...(report.findings !== undefined ? { findings: report.findings } : {}),
    ...(report.validation !== undefined ? { validation: report.validation } : {}),
    ...(report.recommendation !== undefined ? { recommendation: report.recommendation } : {}),
    ...(report.completionPercent !== undefined
      ? { completionPercent: report.completionPercent }
      : {}),
    ...(report.usage !== undefined ? { usage: report.usage } : {}),
  });
}

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
        abstract,
        artifacts_json,
        structured_json,
        origin,
        supersedes_report_id,
        created_at
      )
      VALUES (
        ${row.reportId},
        ${row.threadId},
        ${row.status},
        ${row.title},
        ${row.summary},
        ${row.abstract},
        ${JSON.stringify(row.artifacts)},
        ${encodeStructured(row)},
        ${row.origin},
        ${row.supersedesReportId},
        ${row.createdAt}
      )
      ON CONFLICT (report_id)
      DO UPDATE SET
        thread_id = excluded.thread_id,
        status = excluded.status,
        title = excluded.title,
        summary = excluded.summary,
        abstract = excluded.abstract,
        artifacts_json = excluded.artifacts_json,
        structured_json = excluded.structured_json,
        origin = excluded.origin,
        supersedes_report_id = excluded.supersedes_report_id,
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
        abstract,
        artifacts_json AS "artifacts",
        structured_json AS "structuredJson",
        origin,
        supersedes_report_id AS "supersedesReportId",
        (
          SELECT amendment.report_id
          FROM projection_thread_reports AS amendment
          WHERE amendment.supersedes_report_id = projection_thread_reports.report_id
          ORDER BY amendment.created_at ASC, amendment.report_id ASC
          LIMIT 1
        ) AS "supersededByReportId",
        created_at AS "createdAt"
      FROM projection_thread_reports
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, report_id ASC
    `,
  });

  const findProjectionThreadReportRow = SqlSchema.findOneOption({
    Request: FindProjectionThreadReportInput,
    Result: ProjectionThreadReportDbRowSchema,
    execute: ({ reportId }) => sql`
      SELECT
        report_id AS "reportId",
        thread_id AS "threadId",
        status,
        title,
        summary,
        abstract,
        artifacts_json AS "artifacts",
        structured_json AS "structuredJson",
        origin,
        supersedes_report_id AS "supersedesReportId",
        (
          SELECT amendment.report_id
          FROM projection_thread_reports AS amendment
          WHERE amendment.supersedes_report_id = projection_thread_reports.report_id
          ORDER BY amendment.created_at ASC, amendment.report_id ASC
          LIMIT 1
        ) AS "supersededByReportId",
        created_at AS "createdAt"
      FROM projection_thread_reports
      WHERE report_id = ${reportId}
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
      Effect.map((rows) => rows.map(mapReportRow)),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadReportRepository.listByThreadId:query",
          "ProjectionThreadReportRepository.listByThreadId:decodeRows",
        ),
      ),
    );

  const findByReportId: ProjectionThreadReportRepositoryShape["findByReportId"] = (input) =>
    findProjectionThreadReportRow(input).pipe(
      Effect.map(Option.map(mapReportRow)),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadReportRepository.findByReportId:query",
          "ProjectionThreadReportRepository.findByReportId:decodeRow",
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
    findByReportId,
    deleteByThreadId,
  } satisfies ProjectionThreadReportRepositoryShape;
});

export const ProjectionThreadReportRepositoryLive = Layer.effect(
  ProjectionThreadReportRepository,
  makeProjectionThreadReportRepository,
);
