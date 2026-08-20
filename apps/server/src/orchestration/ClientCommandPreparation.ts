import type { OrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { HandoffBrief } from "./Services/HandoffBrief.ts";

/**
 * Complete client-only command preparation before the command enters the
 * engine's sequential dispatch path. A handoff brief needs a normal provider
 * turn on the origin session, so it must finish before migration is decided.
 */
export const prepareClientOrchestrationCommand = Effect.fn("prepareClientOrchestrationCommand")(
  function* (command: OrchestrationCommand) {
    if (
      command.type !== "thread.migrate" ||
      command.handoffMode !== "brief" ||
      command.brief !== undefined
    ) {
      return command;
    }

    const handoffBrief = yield* HandoffBrief;
    const brief = yield* handoffBrief.create(command.threadId).pipe(
      Effect.catchTag("HandoffBriefTurnFailedError", (error) =>
        Effect.logWarning("handoff brief turn failed; falling back to replay migration", {
          threadId: command.threadId,
          commandId: command.commandId,
          detail: error.detail,
        }).pipe(Effect.as(undefined)),
      ),
    );

    return brief === undefined
      ? ({ ...command, handoffMode: "replay" } satisfies OrchestrationCommand)
      : ({ ...command, brief } satisfies OrchestrationCommand);
  },
);
