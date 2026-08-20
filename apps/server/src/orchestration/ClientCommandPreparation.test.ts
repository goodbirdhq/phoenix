import { CommandId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import {
  HandoffBrief,
  HandoffBriefTurnFailedError,
  type HandoffBriefShape,
} from "./Services/HandoffBrief.ts";
import { prepareClientOrchestrationCommand } from "./ClientCommandPreparation.ts";

const migrateCommand = {
  type: "thread.migrate",
  commandId: CommandId.make("cmd-migrate"),
  threadId: ThreadId.make("thread-1"),
  targetInstanceId: ProviderInstanceId.make("claude_work"),
  handoffMode: "brief",
  trigger: "manual",
  createdAt: "2026-08-19T00:00:00.000Z",
} as const;

it.effect("creates a handoff brief before returning a brief-mode migration for dispatch", () =>
  Effect.gen(function* () {
    const order: Array<string> = [];
    const create = vi.fn<HandoffBriefShape["create"]>((threadId) =>
      Effect.sync(() => {
        order.push(`brief:${threadId}`);
        return "Continue from the focused server tests.";
      }),
    );

    const prepared = yield* prepareClientOrchestrationCommand(migrateCommand).pipe(
      Effect.provideService(HandoffBrief, HandoffBrief.of({ create })),
    );
    order.push("dispatch");

    expect(order).toEqual(["brief:thread-1", "dispatch"]);
    expect(create).toHaveBeenCalledWith(ThreadId.make("thread-1"));
    expect(prepared).toMatchObject({
      handoffMode: "brief",
      brief: "Continue from the focused server tests.",
    });
  }),
);

it.effect("falls back to replay when the origin handoff turn fails", () =>
  Effect.gen(function* () {
    const create = vi.fn<HandoffBriefShape["create"]>((threadId) =>
      Effect.fail(
        new HandoffBriefTurnFailedError({
          threadId,
          turnId: null,
          detail: "Origin account is rate-limited.",
        }),
      ),
    );

    const prepared = yield* prepareClientOrchestrationCommand(migrateCommand).pipe(
      Effect.provideService(HandoffBrief, HandoffBrief.of({ create })),
    );

    expect(create).toHaveBeenCalledOnce();
    expect(prepared).toMatchObject({
      commandId: CommandId.make("cmd-migrate"),
      handoffMode: "replay",
    });
    expect(prepared).not.toHaveProperty("brief");
  }),
);

it.effect("does not regenerate a brief already carried by the command", () =>
  Effect.gen(function* () {
    const create = vi.fn<HandoffBriefShape["create"]>(() =>
      Effect.die("create should not be called for an enriched migration"),
    );

    const prepared = yield* prepareClientOrchestrationCommand({
      ...migrateCommand,
      brief: "Already generated on the origin session.",
    }).pipe(Effect.provideService(HandoffBrief, HandoffBrief.of({ create })));

    expect(create).not.toHaveBeenCalled();
    expect(prepared).toMatchObject({
      handoffMode: "brief",
      brief: "Already generated on the origin session.",
    });
  }),
);
