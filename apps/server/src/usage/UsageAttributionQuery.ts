import { UsageReadError, UsageThread, UsageThreadCreation } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import type { UsageSessionLink } from "./usageAttribution.ts";

export class UsageAttributionQuery extends Context.Service<
  UsageAttributionQuery,
  {
    readonly creations: (
      since: string,
      until: string,
    ) => Effect.Effect<readonly UsageThreadCreation[], UsageReadError>;
    readonly list: () => Effect.Effect<readonly UsageSessionLink[], UsageReadError>;
  }
>()("t3/usage/UsageAttributionQuery") {}

export const layer = Layer.effect(
  UsageAttributionQuery,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({
        providerName: Schema.String,
        providerInstanceId: Schema.String,
        sessionId: Schema.String,
        ...UsageThread.fields,
      }),
      execute: () => sql`
      SELECT links.provider_name AS "providerName", links.provider_instance_id AS "providerInstanceId",
        links.session_id AS "sessionId", threads.thread_id AS id, threads.title,
        threads.created_at AS "createdAt", projects.project_id AS "projectId",
        projects.title AS "projectTitle", projects.workspace_root AS "projectWorkspaceRoot", projects.favicon_path AS "projectFaviconPath"
      FROM usage_session_links links
      JOIN projection_threads threads ON threads.thread_id = links.thread_id
      JOIN projection_projects projects ON projects.project_id = threads.project_id
    `,
    });
    const creations = SqlSchema.findAll({
      Request: Schema.Struct({ since: Schema.String, until: Schema.String }),
      Result: UsageThreadCreation,
      execute: ({ since, until }) => sql`
        SELECT threads.thread_id AS "threadId", threads.created_at AS "createdAt",
          COALESCE(json_extract(events.payload_json, '$.modelSelection.instanceId'), json_extract(events.payload_json, '$.modelSelection.provider')) AS "instanceId"
        FROM projection_threads threads
        LEFT JOIN orchestration_events events ON events.aggregate_kind = 'thread' AND events.stream_id = threads.thread_id AND events.event_type = 'thread.created'
        WHERE threads.created_at >= ${since} AND threads.created_at < ${until}
        ORDER BY threads.created_at, threads.thread_id
      `,
    });
    return {
      creations: (since, until) =>
        creations({ since, until }).pipe(
          Effect.mapError(
            (cause) =>
              new UsageReadError({
                reason: "scanFailed",
                detail: "Could not read session creation history.",
                cause,
              }),
          ),
        ),
      list: () =>
        query(undefined).pipe(
          Effect.map((rows) =>
            rows.map(({ providerName, providerInstanceId, sessionId, ...thread }) => ({
              providerName,
              providerInstanceId,
              sessionId,
              thread,
            })),
          ),
          Effect.mapError(
            (cause) =>
              new UsageReadError({
                reason: "scanFailed",
                detail: "Could not read session attribution.",
                cause,
              }),
          ),
        ),
    };
  }),
);

export const layerTest = Layer.succeed(UsageAttributionQuery, {
  list: () => Effect.succeed([]),
  creations: () => Effect.succeed([]),
});
