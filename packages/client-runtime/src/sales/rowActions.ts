/**
 * Per-row action state for a list acted on row by row: which rows wait on an answer, and the
 * last answer for each. An answer is kept with the state the list showed the row in when it was
 * pressed, and dropped once the list shows the row in another state, so it never outlives what it
 * was about. Framework-free: a view subscribes and renders.
 */
export interface RowActions<O> {
  /**
   * Runs `act` for the row the list shows in `state`. Its answer shows on the row only if `keep`
   * says so; a batch keeps only what needs a look and sums up the rest.
   */
  readonly run: (
    id: string,
    state: string,
    act: () => Promise<O>,
    keep?: (outcome: O) => boolean,
  ) => Promise<O>;
  readonly busy: (id: string) => boolean;
  /** The row's last answer, while the list still shows the row in `state`. */
  readonly outcome: (id: string, state: string) => O | null;
  readonly subscribe: (listener: () => void) => () => void;
  /** Moves on whenever what `busy` or `outcome` answers changes. */
  readonly getVersion: () => number;
}

export function createRowActions<O>(): RowActions<O> {
  const busy = new Set<string>();
  const outcomes = new Map<string, { readonly state: string; readonly outcome: O }>();
  const listeners = new Set<() => void>();
  let version = 0;
  const changed = () => {
    version += 1;
    for (const listener of listeners) listener();
  };

  return {
    run: async (id, state, act, keep = () => true) => {
      busy.add(id);
      outcomes.delete(id);
      changed();
      try {
        const outcome = await act();
        if (keep(outcome)) outcomes.set(id, { state, outcome });
        return outcome;
      } finally {
        busy.delete(id);
        changed();
      }
    },
    busy: (id) => busy.has(id),
    outcome: (id, state) => {
      const kept = outcomes.get(id);
      if (kept === undefined) return null;
      if (kept.state === state) return kept.outcome;
      // The row moved on, so the answer is about a state it has left: forget it for good, so the
      // row coming back to that state later does not bring it back. Nothing shown changes.
      outcomes.delete(id);
      return null;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getVersion: () => version,
  };
}
