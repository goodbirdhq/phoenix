import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { CommandId, EventId, type ThreadId, type TurnId } from "@t3tools/contracts";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { forkParked } from "../../serverActivation.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const crypto = yield* Crypto.Crypto;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    /**
     * Threads already told about a stalled turn, keyed by thread to the turn
     * the notice covers. The sweep repeats every few minutes; the user needs
     * the notice once per stall, not once per sweep. A new turn re-arms it,
     * and recovery clears the entry.
     */
    const stallNotices = new Map<string, string>();

    const appendStalledActivity = (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly idleDurationMs: number;
    }) =>
      Effect.gen(function* () {
        const commandId = yield* crypto.randomUUIDv4.pipe(
          Effect.map((uuid) => CommandId.make(`server:provider-stall-notice:${uuid}`)),
        );
        const eventId = yield* crypto.randomUUIDv4.pipe(Effect.map((uuid) => EventId.make(uuid)));
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const idleMinutes = Math.floor(input.idleDurationMs / 60000);
        yield* orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "error",
            kind: "provider.session.stalled",
            summary: `Provider has not reported for ${idleMinutes} minutes`,
            payload: {
              detail:
                `The provider process is still running but has sent nothing for ${idleMinutes} minutes. ` +
                `It may be wedged, or still inside a long-running tool call — nothing recorded here tells those apart. ` +
                `Stop the turn if it is not making progress.`,
              idleDurationMs: input.idleDurationMs,
            },
            turnId: input.turnId,
            createdAt,
          },
          createdAt,
        });
      });

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        // Keep ordinary ready/stopped reaping cheap and exactly keyed to the
        // persisted binding timestamp. Only the active-turn watchdog needs a
        // shell read and the more conservative session timestamp.
        const idleDurationMs = now - lastSeenMs;
        if (idleDurationMs < inactivityThresholdMs) {
          // Progressing again: re-arm the notice for a future stall.
          stallNotices.delete(binding.threadId);
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));

        // The turn can settle while background work runs on (subagent
        // fleets, workflow runs, Monitor watch loops). Those live inside the
        // provider process, so stopping the session would kill them silently,
        // and nothing bumps lastSeenAt between turns.
        if (thread?.backgroundLiveness != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-background-work", {
            threadId: binding.threadId,
            backgroundLiveness: thread.backgroundLiveness,
            idleDurationMs,
          });
          continue;
        }

        const activeSession = thread?.session;
        const isActiveTurn =
          activeSession?.activeTurnId != null &&
          (activeSession.status === "starting" || activeSession.status === "running");
        if (isActiveTurn) {
          // Directory activity is intentionally not updated for every
          // provider event. The watchdog therefore uses the later session
          // update only for an active turn; ready-session reaping above stays
          // unchanged.
          const sessionUpdatedMs = Date.parse(activeSession.updatedAt);
          const watchdogIdleDurationMs =
            now -
            Math.max(lastSeenMs, Number.isNaN(sessionUpdatedMs) ? lastSeenMs : sessionUpdatedMs);
          if (watchdogIdleDurationMs < inactivityThresholdMs) {
            stallNotices.delete(binding.threadId);
            continue;
          }
          const runtimeLiveness = yield* providerService.getSessionRuntimeLiveness
            ? providerService.getSessionRuntimeLiveness(binding.threadId)
            : Effect.succeed("unknown" as const);
          if (runtimeLiveness !== "dead") {
            // Escalate, do not kill. A live runtime that has gone quiet past
            // the threshold is either wedged or sitting inside a long tool
            // call, and nothing recorded here separates the two. Killing
            // would sometimes destroy live work, and staying silent is what
            // let a wedged turn look busy for 92 minutes — so say so, and
            // leave the decision with the user.
            const stalledTurnId = activeSession.activeTurnId;
            if (stalledTurnId !== null && stallNotices.get(binding.threadId) !== stalledTurnId) {
              stallNotices.set(binding.threadId, stalledTurnId);
              yield* appendStalledActivity({
                threadId: binding.threadId,
                turnId: stalledTurnId,
                idleDurationMs: watchdogIdleDurationMs,
              }).pipe(
                Effect.tap(() =>
                  Effect.logWarning("provider.session.reaper.active-turn-stalled", {
                    threadId: binding.threadId,
                    activeTurnId: stalledTurnId,
                    idleDurationMs: watchdogIdleDurationMs,
                    runtimeLiveness,
                  }),
                ),
                // A thread that cannot take the notice must not stop the
                // sweep from reaping everything behind it.
                Effect.catchCause((cause) =>
                  Effect.logWarning("provider.session.reaper.stall-notice-failed", {
                    threadId: binding.threadId,
                    cause,
                  }),
                ),
              );
            } else {
              yield* Effect.logDebug("provider.session.reaper.skipped-active-turn-runtime-live", {
                threadId: binding.threadId,
                activeTurnId: activeSession.activeTurnId,
                idleDurationMs: watchdogIdleDurationMs,
                runtimeLiveness,
              });
            }
            continue;
          }
          stallNotices.delete(binding.threadId);

          const commandId = yield* crypto.randomUUIDv4.pipe(
            Effect.map((uuid) => CommandId.make(`server:provider-active-turn-watchdog:${uuid}`)),
          );
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          yield* orchestrationEngine
            .dispatch({
              type: "thread.session.set",
              commandId,
              threadId: binding.threadId,
              onlyIfActiveTurnId: activeSession.activeTurnId,
              session: {
                ...activeSession,
                status: "error",
                activeTurnId: null,
                lastError:
                  "Provider session disappeared after inactivity; the active turn was stopped because the provider crashed.",
                stoppedBy: "system",
                stopReason: "provider_crashed",
                updatedAt: createdAt,
              },
              createdAt,
            })
            .pipe(
              Effect.tap(() =>
                Effect.logWarning("provider.session.reaper.active-turn-crashed", {
                  threadId: binding.threadId,
                  activeTurnId: activeSession.activeTurnId,
                  idleDurationMs: watchdogIdleDurationMs,
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.logDebug("provider.session.reaper.active-turn-crash-skipped", {
                  threadId: binding.threadId,
                  activeTurnId: activeSession.activeTurnId,
                  cause,
                }),
              ),
            );
          continue;
        }

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              reason: "inactivity_threshold",
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* forkParked(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
