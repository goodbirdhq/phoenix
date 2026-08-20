import { ScheduleDomainEvent, ScheduleStoredDefinition } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { evolveScheduleDefinition } from "../../schedule/ScheduleDomain.ts";

const historyLayer = it.layer(NodeSqliteClient.layerMemory());
const replayLayer = it.layer(NodeSqliteClient.layerMemory());
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeDomainEventJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduleDomainEvent),
);
const decodeStoredDefinitionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduleStoredDefinition),
);

historyLayer("053_NormalizeScheduleHistory", (it) => {
  it.effect("moves existing history into indexed rows and removes it from copied definitions", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 52 });
      const sql = yield* SqlClient.SqlClient;
      const recordJson = encodeJson({
        id: "schedule-1",
        projectId: "project-1",
        name: "History migration",
        prompt: "Preserve this Schedule",
        timing: { type: "cron", expression: "*/5 * * * *" },
        timeZone: "UTC",
        execution: {
          modelSelection: { instanceId: "codex", model: "gpt-5.6-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceMode: "local",
          baseBranch: null,
        },
        state: "enabled",
        nextOccurrenceAt: null,
        latestHistory: null,
        unacknowledgedFailure: false,
        createdAt: "2026-08-19T00:00:00.000Z",
        updatedAt: "2026-08-19T00:15:00.000Z",
        history: [
          {
            type: "skipped",
            count: 2,
            countIsLowerBound: false,
            firstScheduledFor: "2026-08-19T00:05:00.000Z",
            lastScheduledFor: "2026-08-19T00:10:00.000Z",
            recordedAt: "2026-08-19T00:15:00.000Z",
          },
        ],
        historyNextCursor: null,
      });
      yield* sql`
        INSERT INTO schedule_definitions (
          schedule_id, project_id, record_json, state, next_occurrence_at,
          created_at, updated_at, sequence
        ) VALUES (
          'schedule-1', 'project-1', ${recordJson}, 'enabled', NULL,
          '2026-08-19T00:00:00.000Z', '2026-08-19T00:15:00.000Z', 1
        )
      `;
      yield* sql`
        INSERT INTO schedule_occurrences (
          occurrence_id, schedule_id, scheduled_for, source, status, thread_id,
          definition_json, created_at, updated_at
        ) VALUES (
          '018fd1b2-6610-7e39-8f09-468fa24c8c01', 'schedule-1',
          '2026-08-19T00:15:00.000Z', 'scheduled', 'pending', NULL,
          ${recordJson}, '2026-08-19T00:15:00.000Z', '2026-08-19T00:15:00.000Z'
        )
      `;
      const oldCommandJson = encodeJson({
        type: "schedule.pause",
        commandId: "pause-command",
        scheduleId: "schedule-1",
      });
      const event = yield* sql<{ readonly sequence: number }>`
        INSERT INTO schedule_events (schedule_id, event_type, payload_json, created_at)
        VALUES (
          'schedule-1', 'schedule.paused',
          ${encodeJson({
            type: "schedule.paused",
            command: {
              type: "schedule.pause",
              commandId: "pause-command",
              scheduleId: "schedule-1",
            },
          })},
          '2026-08-19T00:15:00.000Z'
        ) RETURNING sequence
      `;
      yield* sql`
        INSERT INTO schedule_commands (command_id, schedule_id, result_sequence, accepted_at)
        VALUES (
          'pause-command', 'schedule-1', ${event[0]?.sequence ?? 0},
          '2026-08-19T00:15:00.000Z'
        )
      `;
      const oldRunNowCommandJson = encodeJson({
        type: "schedule.run-now",
        commandId: "run-now-command",
        scheduleId: "schedule-1",
        occurrenceId: "018fd1b2-6610-7e39-8f09-468fa24c8c01",
      });
      const runNowEvent = yield* sql<{ readonly sequence: number }>`
        INSERT INTO schedule_events (schedule_id, event_type, payload_json, created_at)
        VALUES (
          'schedule-1', 'schedule.occurrence-reserved',
          ${encodeJson({
            type: "schedule.occurrence-reserved",
            occurrenceId: "018fd1b2-6610-7e39-8f09-468fa24c8c01",
            scheduledFor: "2026-08-19T00:15:00.000Z",
            source: "manual",
          })},
          '2026-08-19T00:15:00.000Z'
        ) RETURNING sequence
      `;
      yield* sql`
        INSERT INTO schedule_commands (command_id, schedule_id, result_sequence, accepted_at)
        VALUES (
          'run-now-command', 'schedule-1', ${runNowEvent[0]?.sequence ?? 0},
          '2026-08-19T00:15:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 53 });

      const history = yield* sql<{ readonly kind: string | null }>`
        SELECT json_extract(record_json, '$.type') AS kind FROM schedule_history
        WHERE schedule_id = 'schedule-1'
      `;
      assert.strictEqual(history.length, 1);
      assert.strictEqual(history[0]?.kind, "skipped");
      const definitions = yield* sql<{ readonly historyType: string | null }>`
        SELECT json_type(record_json, '$.history') AS "historyType" FROM schedule_definitions
        WHERE schedule_id = 'schedule-1'
      `;
      const occurrences = yield* sql<{ readonly historyType: string | null }>`
        SELECT json_type(definition_json, '$.history') AS "historyType" FROM schedule_occurrences
        WHERE schedule_id = 'schedule-1'
      `;
      assert.isNull(definitions[0]?.historyType ?? null);
      assert.isNull(occurrences[0]?.historyType ?? null);
      const receipts = yield* sql<{ readonly commandJson: string | null }>`
        SELECT command_json AS "commandJson" FROM schedule_commands
        WHERE command_id = 'pause-command'
      `;
      assert.strictEqual(receipts[0]?.commandJson, oldCommandJson);
      const runNowReceipts = yield* sql<{ readonly commandJson: string | null }>`
        SELECT command_json AS "commandJson" FROM schedule_commands
        WHERE command_id = 'run-now-command'
      `;
      assert.strictEqual(runNowReceipts[0]?.commandJson, oldRunNowCommandJson);
    }),
  );
});

replayLayer("053_NormalizeScheduleHistory legacy replay", (it) => {
  it.effect("rebases real v51 active and deleted streams into replayable versioned events", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 52 });
      const sql = yield* SqlClient.SqlClient;
      const definition = {
        id: "legacy-replay",
        projectId: "project-1",
        name: "Legacy replay",
        prompt: "Rebuild this v51 Schedule",
        timing: { type: "cron", expression: "*/5 * * * *" },
        timeZone: "UTC",
        execution: {
          modelSelection: { instanceId: "codex", model: "gpt-5.6-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceMode: "local",
          baseBranch: null,
        },
        state: "paused",
        nextOccurrenceAt: null,
        latestHistory: null,
        unacknowledgedFailure: false,
        createdAt: "2026-08-19T00:00:00.000Z",
        updatedAt: "2026-08-19T00:05:00.000Z",
        history: [],
        historyNextCursor: null,
      };
      const created = yield* sql<{ readonly sequence: number }>`
        INSERT INTO schedule_events (schedule_id, event_type, payload_json, created_at)
        VALUES (
          'legacy-replay', 'schedule.created',
          ${encodeJson({
            type: "schedule.created",
            command: {
              type: "schedule.create",
              commandId: "legacy-create",
              scheduleId: "legacy-replay",
              projectId: "project-1",
              name: "Legacy replay",
              prompt: "Rebuild this v51 Schedule",
              timing: { type: "cron", expression: "*/5 * * * *" },
              timeZone: "UTC",
              execution: definition.execution,
              state: "enabled",
            },
          })},
          '2026-08-19T00:00:00.000Z'
        ) RETURNING sequence
      `;
      const paused = yield* sql<{ readonly sequence: number }>`
        INSERT INTO schedule_events (schedule_id, event_type, payload_json, created_at)
        VALUES (
          'legacy-replay', 'schedule.paused',
          ${encodeJson({
            type: "schedule.paused",
            command: {
              type: "schedule.pause",
              commandId: "legacy-pause",
              scheduleId: "legacy-replay",
            },
          })},
          '2026-08-19T00:05:00.000Z'
        ) RETURNING sequence
      `;
      yield* sql`
        INSERT INTO schedule_events (schedule_id, event_type, payload_json, created_at)
        VALUES
          (
            'legacy-deleted', 'schedule.created',
            ${encodeJson({
              type: "schedule.created",
              command: {
                type: "schedule.create",
                commandId: "legacy-deleted-create",
                scheduleId: "legacy-deleted",
              },
            })},
            '2026-08-19T00:00:00.000Z'
          ),
          (
            'legacy-deleted', 'schedule.deleted',
            ${encodeJson({
              type: "schedule.delete",
              commandId: "legacy-delete",
              scheduleId: "legacy-deleted",
            })},
            '2026-08-19T00:06:00.000Z'
          )
      `;
      yield* sql`
        INSERT INTO schedule_definitions (
          schedule_id, project_id, record_json, state, next_occurrence_at,
          created_at, updated_at, sequence
        ) VALUES (
          'legacy-replay', 'project-1', ${encodeJson(definition)}, 'paused', NULL,
          '2026-08-19T00:00:00.000Z', '2026-08-19T00:05:00.000Z',
          ${paused[0]?.sequence ?? 0}
        )
      `;
      yield* sql`
        INSERT INTO schedule_commands (command_id, schedule_id, result_sequence, accepted_at)
        VALUES
          ('legacy-create', 'legacy-replay', ${created[0]?.sequence ?? 0},
            '2026-08-19T00:00:00.000Z'),
          ('legacy-pause', 'legacy-replay', ${paused[0]?.sequence ?? 0},
            '2026-08-19T00:05:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 53 });

      const rows = yield* sql<{
        readonly eventType: string;
        readonly payloadJson: string;
        readonly payloadVersion: number;
      }>`
        SELECT event_type AS "eventType", payload_json AS "payloadJson",
          payload_version AS "payloadVersion"
        FROM schedule_events
        WHERE schedule_id = 'legacy-replay'
        ORDER BY sequence ASC
      `;
      const events = yield* Effect.forEach(rows, ({ payloadJson }) =>
        decodeDomainEventJson(payloadJson),
      );
      const rebuilt = events.reduce(evolveScheduleDefinition, null);
      const stored = yield* sql<{ readonly recordJson: string }>`
        SELECT record_json AS "recordJson" FROM schedule_definitions
        WHERE schedule_id = 'legacy-replay'
      `;
      const deletedRows = yield* sql<{
        readonly payloadJson: string;
        readonly payloadVersion: number;
      }>`
        SELECT payload_json AS "payloadJson", payload_version AS "payloadVersion"
        FROM schedule_events
        WHERE schedule_id = 'legacy-deleted'
        ORDER BY sequence ASC
      `;
      const deletedEvents = yield* Effect.forEach(deletedRows, ({ payloadJson }) =>
        decodeDomainEventJson(payloadJson),
      );

      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.eventType, "schedule.rebased");
      assert.strictEqual(rows[0]?.payloadVersion, 2);
      assert.deepStrictEqual(
        rebuilt,
        yield* decodeStoredDefinitionJson(stored[0]?.recordJson ?? ""),
      );
      assert.strictEqual(deletedRows.length, 1);
      assert.strictEqual(deletedRows[0]?.payloadVersion, 2);
      assert.isNull(deletedEvents.reduce(evolveScheduleDefinition, null));
    }),
  );
});
