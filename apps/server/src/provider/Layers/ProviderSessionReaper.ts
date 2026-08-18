import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { CommandId } from "@t3tools/contracts";

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
            continue;
          }
          const runtimeLiveness = yield* providerService.getSessionRuntimeLiveness
            ? providerService.getSessionRuntimeLiveness(binding.threadId)
            : Effect.succeed("unknown" as const);
          if (runtimeLiveness !== "dead") {
            yield* Effect.logDebug("provider.session.reaper.skipped-active-turn-runtime-live", {
              threadId: binding.threadId,
              activeTurnId: activeSession.activeTurnId,
              idleDurationMs: watchdogIdleDurationMs,
              runtimeLiveness,
            });
            continue;
          }

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
