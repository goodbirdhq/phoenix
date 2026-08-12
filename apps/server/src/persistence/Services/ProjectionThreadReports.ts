/**
 * ProjectionThreadReportRepository - Projection repository interface for session reports.
 *
 * Owns persistence operations for completion reports posted by threads,
 * projected from orchestration events.
 *
 * @module ProjectionThreadReportRepository
 */
import {
  IsoDateTime,
  SessionReportArtifact,
  SessionReportOrigin,
  SessionReportStatus,
  SessionReportStructured,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadReport = Schema.Struct({
  reportId: TrimmedNonEmptyString,
  threadId: ThreadId,
  status: SessionReportStatus,
  title: TrimmedNonEmptyString,
  summary: Schema.String,
  abstract: Schema.NullOr(Schema.String),
  artifacts: Schema.Array(SessionReportArtifact),
  // Mirrors the same bounds (array lengths, string lengths, 0-100 percent)
  // as the contract-level SessionReport/PostReportInput.
  ...SessionReportStructured.fields,
  origin: SessionReportOrigin,
  createdAt: IsoDateTime,
});
export type ProjectionThreadReport = typeof ProjectionThreadReport.Type;

export const ListProjectionThreadReportsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadReportsInput = typeof ListProjectionThreadReportsInput.Type;

export const FindProjectionThreadReportInput = Schema.Struct({
  reportId: TrimmedNonEmptyString,
});
export type FindProjectionThreadReportInput = typeof FindProjectionThreadReportInput.Type;

export const DeleteProjectionThreadReportsInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadReportsInput = typeof DeleteProjectionThreadReportsInput.Type;

/**
 * ProjectionThreadReportRepositoryShape - Service API for projected session reports.
 */
export interface ProjectionThreadReportRepositoryShape {
  /**
   * Insert or replace a projected session report row.
   *
   * Upserts by `reportId` and JSON-encodes artifacts.
   */
  readonly upsert: (
    report: ProjectionThreadReport,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List projected session report rows for a thread, ordered by creation time.
   */
  readonly listByThreadId: (
    input: ListProjectionThreadReportsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadReport>, ProjectionRepositoryError>;

  /**
   * Find a single projected session report row by report id.
   */
  readonly findByReportId: (
    input: FindProjectionThreadReportInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadReport>, ProjectionRepositoryError>;

  /**
   * Delete projected session report rows by thread.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadReportsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadReportRepository - Service tag for session report persistence.
 */
export class ProjectionThreadReportRepository extends Context.Service<
  ProjectionThreadReportRepository,
  ProjectionThreadReportRepositoryShape
>()("t3/persistence/Services/ProjectionThreadReports/ProjectionThreadReportRepository") {}
