import { CommandId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { forkParked } from "../../serverActivation.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// A turn is allowed to look idle far longer than an idle session before the
// watchdog calls it dead. `lastSeenAt` is bumped by session-level operations
// (start, sendTurn, stop, recover), not by every runtime event, so under an
// active turn "stale" only proves the turn *started* long ago — a real agent
// grinding through a long tool call looks identical. An hour, on top of the
// dead-runtime check below, keeps a legitimate long turn safe while still
// freeing a session that would otherwise read "running" forever.
const DEFAULT_ACTIVE_TURN_INACTIVITY_THRESHOLD_MS = 60 * 60 * 1000;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
  readonly activeTurnInactivityThresholdMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const activeTurnInactivityThresholdMs = Math.max(
      1,
      options?.activeTurnInactivityThresholdMs ?? DEFAULT_ACTIVE_TURN_INACTIVITY_THRESHOLD_MS,
    );

    // Liveness is read from the adapters' in-memory session table, the same
    // signal SessionSpawnReactor's stranded-turn recovery trusts. It is also
    // the failure-safe direction: if the lookup fails we assume the session is
    // alive and leave it alone.
    const hasLiveProviderSession = (threadId: string) =>
      providerService.listSessions().pipe(
        Effect.map((sessions) => sessions.some((session) => session.threadId === threadId)),
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.session.watchdog.liveness-lookup-failed", {
            threadId,
            cause,
          }).pipe(Effect.as(true)),
        ),
      );

    // Whichever pass wakes first decides when a binding is worth a projection
    // read; each pass then re-checks its own threshold. Keeping the two
    // independent means a test (or a future retune) can lower one without
    // silently gating it behind the other.
    const readModelThresholdMs = Math.min(inactivityThresholdMs, activeTurnInactivityThresholdMs);

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;
      let crashedCount = 0;

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

        const idleDurationMs = now - lastSeenMs;
        if (idleDurationMs < readModelThresholdMs) {
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        const session = thread?.session;
        // Only a session the read model still believes is live on this turn is
        // the watchdog's business. A terminal session that never had its
        // active turn cleared keeps the reaper's original skip: it is already
        // audited, and rewriting it would say nothing new.
        if (
          session?.activeTurnId != null &&
          session.status !== "running" &&
          session.status !== "starting"
        ) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: session.activeTurnId,
            status: session.status,
            idleDurationMs,
          });
          continue;
        }
        if (session?.activeTurnId != null) {
          const activeTurnId = session.activeTurnId;
          // The session projection moves on every provider lifecycle
          // transition, so it is the fresher of the two clocks whenever a turn
          // is actually producing them; take whichever ran most recently.
          const sessionUpdatedMs = Date.parse(session.updatedAt);
          const lastObservedMs = Number.isNaN(sessionUpdatedMs)
            ? lastSeenMs
            : Math.max(lastSeenMs, sessionUpdatedMs);
          const activeTurnIdleMs = now - lastObservedMs;
          if (activeTurnIdleMs < activeTurnInactivityThresholdMs) {
            yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
              threadId: binding.threadId,
              activeTurnId,
              idleDurationMs,
              activeTurnIdleMs,
            });
            continue;
          }

          // A runtime the adapters still hold is doing work we cannot see —
          // a long tool call, a quiet model, native background work — and
          // must never be declared crashed. `backgroundLiveness` deliberately
          // does not get its own veto here: it is derived from the same
          // provider process, so once that process is gone the liveness flag
          // is stale by construction, and honouring it would leave exactly
          // the sessions this watchdog exists for stuck at "running".
          if (yield* hasLiveProviderSession(binding.threadId)) {
            yield* Effect.logDebug("provider.session.reaper.skipped-live-runtime", {
              threadId: binding.threadId,
              activeTurnId,
              activeTurnIdleMs,
              backgroundLiveness: thread?.backgroundLiveness ?? null,
            });
            continue;
          }

          const stoppedAt = DateTime.formatIso(yield* DateTime.now);
          const idleMinutes = Math.round(activeTurnIdleMs / 60_000);
          const crashed = yield* orchestrationEngine
            .dispatch({
              type: "thread.session.set",
              // Deterministic in the observation it was decided from: a repeat
              // sweep that sees the same dead runtime dedupes on the command
              // receipt instead of appending a second crash event, while any
              // fresh provider activity moves the timestamp and mints a new
              // command.
              commandId: CommandId.make(
                `server:provider-inactivity-watchdog:${binding.threadId}:${activeTurnId}:${lastObservedMs}`,
              ),
              threadId: binding.threadId,
              session: {
                ...session,
                status: "error",
                activeTurnId: null,
                lastError: `Provider session stopped responding for ${idleMinutes} minute${idleMinutes === 1 ? "" : "s"} while turn ${activeTurnId} was running, and its runtime is gone. Phoenix marked the session crashed.`,
                stoppedBy: "system",
                stopReason: "provider_crashed",
                stopRequestedAt: stoppedAt,
                updatedAt: stoppedAt,
              },
              // Decided against the live read model, not this snapshot: a
              // heartbeat or a real terminal event landing in between wins.
              onlyIfActiveTurnId: activeTurnId,
              createdAt: stoppedAt,
            })
            .pipe(
              Effect.tap(() =>
                Effect.logWarning("provider.session.watchdog.crashed", {
                  threadId: binding.threadId,
                  provider: binding.provider,
                  activeTurnId,
                  activeTurnIdleMs,
                }),
              ),
              Effect.as(true),
              // A rejected conditional command is the guard doing its job (the
              // session moved on), not a failure worth escalating.
              Effect.catchCause((cause) =>
                Effect.logDebug("provider.session.watchdog.crash-not-applied", {
                  threadId: binding.threadId,
                  activeTurnId,
                  cause,
                }).pipe(Effect.as(false)),
              ),
            );

          if (!crashed) {
            // The guard refused the write, which means the session is alive
            // again on newer state than this sweep read. Leaving the binding
            // alone is the whole point: stopping it here would kill the very
            // work that just disproved the crash.
            continue;
          }
          crashedCount += 1;

          // The binding outlived its runtime; clearing it now stops the next
          // sweep from re-examining a session that can never come back on this
          // process, and releases the row for a fresh start.
          yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
            Effect.catchCause((cause) =>
              Effect.logDebug("provider.session.watchdog.stop-failed", {
                threadId: binding.threadId,
                cause,
              }),
            ),
          );
          continue;
        }

        // Past the watchdog: this is the ordinary idle-session sweep, which
        // keeps its own threshold.
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }

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

      if (reapedCount > 0 || crashedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          crashedCount,
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
          activeTurnInactivityThresholdMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
