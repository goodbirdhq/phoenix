import type {
  SalesCardState,
  SalesDispatch,
  SalesDispatchInput,
  SalesEditInput,
  SalesEditResult,
  SalesHoldResult,
  SalesQueueItemDetail,
  SalesResumeResult,
} from "@t3tools/contracts";
import { safeSalesNote } from "@t3tools/contracts";

import type { AtomCommandResult } from "../state/runtime.ts";
import type { ApproveOutcome } from "./approve.ts";
import { checkSigning, type SigningDevice } from "./devices.ts";
import { readSalesFailure, versionRefusalText } from "./failure.ts";
import { holdOutcome, resumeOutcome, type SalesHoldOutcome } from "./hold.ts";
import { cardActions, listedVersionMoved } from "./outreach.ts";
import { displayedDraft, type VerifiedVersion, verifyDisplayedVersion } from "./signing.ts";

export interface DraftNotice {
  readonly tone: "success" | "warning" | "error";
  readonly title: string;
  readonly description?: string;
  /** The thread a dispatch started, to link from the notice. */
  readonly thread?: SalesDispatch;
}

export interface DraftCardState {
  /** The card as last read, or null before the first read lands. */
  readonly detail: SalesQueueItemDetail | null;
  readonly loadFailure: string | null;
  /**
   * Whether the card shows its inputs. Off, it shows the email as it will go. An unsaved edit
   * keeps it on (see `isEditing`).
   */
  readonly editing: boolean;
  /** The person's unsaved edit; null while that field is unedited. */
  readonly subjectDraft: string | null;
  readonly bodyDraft: string | null;
  readonly notice: DraftNotice | null;
  /** Text from an edit the engine refused because the card moved on, kept so it is not lost. */
  readonly lostText: string | null;
  /** The action running now. One runs at a time: a press while one runs does nothing. */
  readonly busy: "approve" | "edit" | "dispatch" | "discard" | "hold" | "resume" | null;
  /** The note for the card's redraft plan, or null while that form is closed. */
  readonly redraftNote: string | null;
}

/** What the card asks of its environment and its page. */
export interface DraftCardCommands {
  readonly getQueueItem: () => Promise<AtomCommandResult<SalesQueueItemDetail, unknown>>;
  readonly edit: (input: SalesEditInput) => Promise<AtomCommandResult<SalesEditResult, unknown>>;
  readonly discard: (expectedHash: string) => Promise<AtomCommandResult<SalesCardState, unknown>>;
  readonly hold: () => Promise<AtomCommandResult<SalesHoldResult, unknown>>;
  readonly resume: (expectedHash: string) => Promise<AtomCommandResult<SalesResumeResult, unknown>>;
  readonly dispatch: (
    input: SalesDispatchInput,
  ) => Promise<AtomCommandResult<SalesDispatch, unknown>>;
  /** Signs and sends verified versions on this device (`approveVersions`). */
  readonly approveVersions: (
    device: SigningDevice,
    versions: ReadonlyArray<VerifiedVersion>,
  ) => Promise<ReadonlyArray<ApproveOutcome>>;
  /** Asks the person to confirm; undefined when there is no way to ask. */
  readonly confirm: (message: string) => Promise<boolean> | undefined;
  /** Called after every action, so a page can read its own list again. */
  readonly onChanged: () => void;
  /** Called when a plan discarded the draft but the run that replaces it did not start. */
  readonly onDiscardedWithoutRun: (message: string) => void;
}

export interface DraftCard {
  readonly getState: () => DraftCardState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Replaces the commands later actions use, such as a page's newer callbacks. */
  readonly setCommands: (commands: DraftCardCommands) => void;
  /** Reads the card again, dropping any unsaved edit. */
  readonly load: () => Promise<void>;
  /** The list now shows this hash for the card; a move reads it again unless mid-edit. */
  readonly setListedHash: (listedHash: string | null) => void;
  /** Shows the inputs, where the card's state allows an edit. */
  readonly startEdit: () => void;
  readonly editSubject: (subject: string) => void;
  readonly editBody: (body: string) => void;
  /** Drops the edit and returns to the email, showing the engine's newer version if it has one. */
  readonly cancelEdit: () => void;
  readonly save: () => Promise<void>;
  /** Approves the version shown, after hashing that text again here. */
  readonly approve: (device: SigningDevice) => Promise<void>;
  /** Pauses a route chase, or withdraws a person's approval; the notice says which. */
  readonly hold: () => Promise<void>;
  /** Gives a paused route chase back to the autopilot, for the version shown. */
  readonly resume: () => Promise<void>;
  /** Asks `${label}?` and discards the card if the person confirms. */
  readonly discard: (label: string) => Promise<void>;
  readonly research: () => Promise<void>;
  readonly toggleRedraft: () => void;
  readonly setRedraftNote: (note: string) => void;
  readonly startRedraft: () => Promise<void>;
}

const holdNotice = ({ tone, title, description }: SalesHoldOutcome): DraftNotice => ({
  tone,
  title,
  description,
});

export const isDirty = (state: DraftCardState) =>
  state.subjectDraft !== null || state.bodyDraft !== null;

/** Whether the card shows inputs rather than the email: opened for an edit, or holding one. */
export const isEditing = (state: DraftCardState) => state.editing || isDirty(state);

/**
 * One draft card: read, edited in place, and acted on. What it shows comes from the card's hash
 * inputs, and `approve` signs only a version it has just hashed from exactly that text
 * (`verifyDisplayedVersion`); a draft that moved on is read again and shown, never signed for
 * the person. Framework-free: a view subscribes and renders `getState()`.
 *
 * A view hands in its latest callbacks with `setCommands`.
 */
export function createDraftCard(
  initialCommands: DraftCardCommands,
  initialListedHash: string | null,
): DraftCard {
  let current = initialCommands;
  const commands = () => current;
  let state: DraftCardState = {
    detail: null,
    loadFailure: null,
    editing: false,
    subjectDraft: null,
    bodyDraft: null,
    notice: null,
    lostText: null,
    busy: null,
    redraftNote: null,
  };
  let listedHash = initialListedHash;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<DraftCardState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const notify = (notice: DraftNotice | null) => set({ notice });

  const load = async () => {
    const result = await commands().getQueueItem();
    if (result._tag === "Success") {
      set({
        detail: result.value,
        loadFailure: null,
        editing: false,
        subjectDraft: null,
        bodyDraft: null,
      });
    } else {
      set({ loadFailure: readSalesFailure(result).description });
    }
  };

  /**
   * Runs one action on the card as read at the press, unless another is running; a read that
   * lands meanwhile changes what the next press acts on, never this one.
   */
  const run = async (
    busy: NonNullable<DraftCardState["busy"]>,
    action: (detail: SalesQueueItemDetail) => Promise<void>,
  ) => {
    const detail = state.detail;
    if (detail === null || state.busy !== null) return;
    set({ busy });
    try {
      await action(detail);
    } finally {
      set({ busy: null });
      commands().onChanged();
    }
  };

  const failureNotice = (failure: { readonly title: string; readonly description: string }) =>
    notify({ tone: "error", title: failure.title, description: failure.description });

  const dispatch = (input: SalesDispatchInput, after?: () => Promise<void>) =>
    run("dispatch", async () => {
      const result = await commands().dispatch(input);
      if (result._tag === "Success") {
        set({
          redraftNote: null,
          notice: { tone: "success", title: "Run started", thread: result.value },
        });
        await after?.();
        return;
      }
      const failure = readSalesFailure(result);
      failureNotice(failure);
      if (failure.state === "discarded") commands().onDiscardedWithoutRun(failure.description);
      if (failure.reread) await load();
    });

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setCommands: (next) => {
      current = next;
    },
    load,

    setListedHash: (next) => {
      const previous = listedHash;
      listedHash = next;
      // Only a change in the listed hash reads again, so a read that disagrees with the list
      // cannot loop.
      if (!listedVersionMoved(previous, next, state.detail?.contentHash ?? null)) return;
      if (isDirty(state)) {
        notify({
          tone: "warning",
          title: "This draft changed in the engine",
          description: "Saving now will be refused. Cancel your edit to see the new version.",
        });
      } else {
        void load();
      }
    },

    startEdit: () => {
      const { detail, busy } = state;
      if (detail === null || busy !== null || !cardActions(detail).edit) return;
      set({ editing: true });
    },
    editSubject: (subject) => set({ subjectDraft: subject }),
    editBody: (body) => set({ bodyDraft: body }),
    cancelEdit: () => {
      set({ editing: false, subjectDraft: null, bodyDraft: null, notice: null });
      // The engine moved on during the edit: show its version now.
      if (listedHash !== null && listedHash !== state.detail?.contentHash) void load();
    },

    save: () =>
      run("edit", async (detail) => {
        const shown = displayedDraft(detail);
        const body = state.bodyDraft ?? shown.body;
        const subject = state.subjectDraft;
        const result = await commands().edit({
          activityId: detail.activityId,
          expectedHash: detail.contentHash,
          body,
          // A threaded draft's subject is its thread's; only a new thread sends one.
          ...(detail.threaded || subject === null ? {} : { subject }),
        });
        if (result._tag === "Success") {
          set({
            lostText: null,
            notice: {
              tone: "success",
              title: "Saved",
              description: result.value.approvalLapsed
                ? "It was approved; that approval lapsed with the edit."
                : "It needs an approval before it goes.",
            },
          });
          await load();
          return;
        }
        const failure = readSalesFailure(result);
        failureNotice(failure);
        if (failure.reread) {
          set({ lostText: body });
          await load();
        }
      }),

    approve: async (device) => {
      if (state.detail === null || state.busy !== null) return;
      // Approval signs the email as shown, so not while the inputs are open, typed in or not.
      if (isEditing(state)) {
        notify({ tone: "warning", title: "Finish or cancel your edit before approving." });
        return;
      }
      const { refusal } = checkSigning(device);
      if (refusal !== null) {
        notify({ tone: "warning", ...refusal });
        return;
      }
      await run("approve", async (detail) => {
        const check = await verifyDisplayedVersion(detail);
        if (!check.ok) {
          notify({
            tone: "error",
            title: "Phoenix will not sign this",
            description: versionRefusalText(check.reason, "card"),
          });
          await load();
          return;
        }
        const [outcome] = await commands().approveVersions(device, [check.version]);
        if (outcome === undefined) return;
        notify({
          tone: outcome.ok ? "success" : outcome.stale || outcome.unknown ? "warning" : "error",
          title: outcome.ok ? "Approved" : outcome.unknown ? "Outcome unknown" : "Not approved",
          description: outcome.text,
        });
        await load();
      });
    },

    hold: () =>
      run("hold", async () => {
        notify(holdNotice(holdOutcome(await commands().hold())));
        await load();
      }),

    resume: () =>
      run("resume", async (detail) => {
        notify(holdNotice(resumeOutcome(await commands().resume(detail.contentHash))));
        await load();
      }),

    discard: (label) =>
      run("discard", async (detail) => {
        const confirmation = commands().confirm(
          `${label}?\nIt is never sent. The Notion row becomes a note.`,
        );
        // No way to ask means no confirmation, so nothing is discarded.
        if (confirmation === undefined) {
          notify({
            tone: "error",
            title: "Could not ask to confirm",
            description: "Nothing was discarded.",
          });
          return;
        }
        if (!(await confirmation)) return;
        const failure = readSalesFailure(await commands().discard(detail.contentHash));
        if (failure === null) {
          notify({ tone: "success", title: "Discarded", description: "It will not be sent." });
        } else {
          failureNotice(failure);
        }
        await load();
      }),

    research: () => {
      const plan = state.detail?.dispatch.research ?? null;
      if (state.detail === null || plan === null) return Promise.resolve();
      return dispatch({
        activityId: state.detail.activityId,
        action: "research",
        expectedHash: plan.card?.expectedHash ?? null,
        note: "",
      });
    },

    toggleRedraft: () => set({ redraftNote: state.redraftNote === null ? "" : null }),
    setRedraftNote: (note) => set({ redraftNote: note }),
    startRedraft: () => {
      const { detail, redraftNote } = state;
      const plan = detail?.dispatch.redraft ?? null;
      if (detail === null || plan === null || redraftNote === null) return Promise.resolve();
      if (plan.noteRequired && safeSalesNote(redraftNote).length === 0) return Promise.resolve();
      // A plan may discard this card first, so read it again after.
      return dispatch(
        {
          activityId: detail.activityId,
          action: "redraft",
          expectedHash: plan.card?.expectedHash ?? null,
          note: redraftNote,
        },
        load,
      );
    },
  };
}
