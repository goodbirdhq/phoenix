import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  createThreadEnvironmentAtoms,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

export const threadEnvironment = createThreadEnvironmentAtoms(connectionAtomRuntime);
export const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("web-environment-thread:empty"),
);

const EMPTY_CHILD_THREAD_SHELLS: ReadonlyArray<EnvironmentThreadShell> = Object.freeze([]);
const EMPTY_CHILD_THREAD_SHELLS_ATOM = Atom.make(EMPTY_CHILD_THREAD_SHELLS).pipe(
  Atom.withLabel("web-child-thread-shells:empty"),
);

const ZERO_COUNT_ATOM = Atom.make(0).pipe(Atom.withLabel("web-active-child-thread-count:empty"));

/**
 * Threads this thread's agent spawned via the `sessions` MCP toolkit.
 *
 * Every child's shell changes identity on each provider update, so only
 * subscribe from a component that is showing the roster. Callers that just
 * need a badge want {@link useSpawnedSessionCount}, which yields a number.
 */
export function useSpawnedThreadShells(
  ref: ScopedThreadRef | null,
): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(
    ref === null
      ? EMPTY_CHILD_THREAD_SHELLS_ATOM
      : environmentThreadShells.childThreadShellsAtom(ref),
  );
}

/** How many spawned sessions are still unsettled. Changes only on spawn/settle. */
export function useSpawnedSessionCount(ref: ScopedThreadRef | null): number {
  return useAtomValue(
    ref === null ? ZERO_COUNT_ATOM : environmentThreadShells.activeChildThreadCountAtom(ref),
  );
}

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  return Option.getOrElse(
    AsyncResult.value(result),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState;
}
