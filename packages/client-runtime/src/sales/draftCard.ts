import type {
  SalesCardState,
  SalesDispatch,
  SalesDispatchInput,
  SalesEditInput,
  SalesEditResult,
  SalesQueueItemDetail,
} from "@t3tools/contracts";

import type { AtomCommandResult } from "../state/runtime.ts";
import { displayedDraft, type VerifiedVersion, verifyDisplayedVersion } from "./signing.ts";
import type { ApproveOutcome } from "./approve.ts";
import { type SalesDeviceKey, type ThisDeviceState, thisDeviceDescription } from "./devices.ts";
import { readSalesFailure } from "./failure.ts";
import { listedVersionMoved } from "./outreach.ts";

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
  /** The person's unsaved edit; null while that field is unedited. */
  readonly subjectDraft: string | null;
  readonly bodyDraft: string | null;
  readonly notice: DraftNotice | null;
  /** Text from an edit the engine refused because the card moved on, kept so it is not lost. */
  readonly lostText: string | null;
  /** The action running now. One runs at a time; the others wait for it. */
  readonly busy: "approve" | "edit" | "dispatch" | "discard" | "unapprove" | null;
  /** The note for Redraft with notes, or null while that form is closed. */
  readonly redraftNote: string | null;
}

/** This device as approval needs it, read at the press. */
export interface DraftCardDevice {
  readonly key: SalesDeviceKey | null;
  readonly state: ThisDeviceState;
  /** Why this client may not sign at all, or null. */
  readonly blocked: string | null;
}

/** What the card asks of its environment and its page. */
export interface DraftCardCommands {
  readonly getQueueItem: () => Promise<AtomCommandResult<SalesQueueItemDetail, unknown>>;
  readonly edit: (input: SalesEditInput) => Promise<AtomCommandResult<SalesEditResult, unknown>>;
  readonly discard: (expectedHash: string) => Promise<AtomCommandResult<SalesCardState, unknown>>;
  readonly unapprove: () => Promise<AtomCommandResult<SalesCardState, unknown>>;
  readonly dispatch: (
    input: SalesDispatchInput,
  ) => Promise<AtomCommandResult<SalesDispatch, unknown>>;
  /** Signs and sends verified versions (`approveVersions`). */
  readonly approveVersions: (
    key: SalesDeviceKey,
    versions: ReadonlyArray<VerifiedVersion>,
  ) => Promise<ReadonlyArray<ApproveOutcome>>;
  /** Asks the person to confirm; undefined when there is no way to ask. */
  readonly confirm: (message: string) => Promise<boolean> | undefined;
  /** Called after every action, so a page can read its own list again. */
  readonly onChanged: () => void;
  /** Called when a reply redraft discarded the answer but its run did not start. */
  readonly onAnswerDiscarded: (message: string) => void;
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
  readonly editSubject: (subject: string) => void;
  readonly editBody: (body: string) => void;
  /** Drops the edit, and shows the engine's newer version if the list has one. */
  readonly cancelEdit: () => void;
  readonly save: () => Promise<void>;
  /** Approves the version shown, after hashing that text again here. */
  readonly approve: (device: DraftCardDevice) => Promise<void>;
  readonly unapprove: () => Promise<void>;
  /** Asks `${label}?` and discards the card if the person confirms. */
  readonly discard: (label: string) => Promise<void>;
  readonly research: () => Promise<void>;
  readonly toggleRedraft: () => void;
  readonly setRedraftNote: (note: string) => void;
  readonly startRedraft: () => Promise<void>;
}

export const isDirty = (state: DraftCardState) =>
  state.subjectDraft !== null || state.bodyDraft !== null;

const verifyRefusal = (reason: string) =>
  reason === "algorithm"
    ? "The engine hashes drafts in a way this version of Phoenix does not know. Update Phoenix."
    : reason === "subject-lines"
      ? "The subject has a line break. Edit it onto one line, then approve."
      : "The text shown is not the version the engine reports. It has been read again; look before approving.";

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
      set({ detail: result.value, loadFailure: null, subjectDraft: null, bodyDraft: null });
    } else {
      set({ loadFailure: readSalesFailure(result)?.description ?? "Could not read this draft." });
    }
  };

  /** Runs one action on a read card, unless another is running. */
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
      const failure = readSalesFailure(result)!;
      failureNotice(failure);
      if (failure.state === "discarded") commands().onAnswerDiscarded(failure.description);
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

    editSubject: (subject) => set({ subjectDraft: subject }),
    editBody: (body) => set({ bodyDraft: body }),
    cancelEdit: () => {
      set({ subjectDraft: null, bodyDraft: null, notice: null });
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
        const failure = readSalesFailure(result)!;
        failureNotice(failure);
        if (failure.reread) {
          set({ lostText: body });
          await load();
        }
      }),

    approve: async (device) => {
      if (state.detail === null || state.busy !== null) return;
      if (isDirty(state)) {
        notify({ tone: "warning", title: "Save or cancel your edit before approving." });
        return;
      }
      if (device.blocked !== null) {
        notify({
          tone: "warning",
          title: "This client cannot approve",
          description: device.blocked,
        });
        return;
      }
      const key = device.key;
      if (key === null || device.state !== "active") {
        notify({
          tone: "warning",
          title: "This device cannot approve",
          description: thisDeviceDescription(device.state, key),
        });
        return;
      }
      await run("approve", async (detail) => {
        const check = await verifyDisplayedVersion(detail);
        if (!check.ok) {
          notify({
            tone: "error",
            title: "Phoenix will not sign this",
            description: verifyRefusal(check.reason),
          });
          await load();
          return;
        }
        const [outcome] = await commands().approveVersions(key, [check.version]);
        if (outcome === undefined) return;
        notify({
          tone: outcome.ok ? "success" : outcome.stale || outcome.unknown ? "warning" : "error",
          title: outcome.ok ? "Approved" : outcome.unknown ? "Outcome unknown" : "Not approved",
          description: outcome.text,
        });
        await load();
      });
    },

    unapprove: () =>
      run("unapprove", async () => {
        const failure = readSalesFailure(await commands().unapprove());
        if (failure === null) notify({ tone: "success", title: "Approval withdrawn" });
        else failureNotice(failure);
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

    research: () =>
      state.detail === null
        ? Promise.resolve()
        : dispatch({ action: "research", activityId: state.detail.activityId }),

    toggleRedraft: () => set({ redraftNote: state.redraftNote === null ? "" : null }),
    setRedraftNote: (note) => set({ redraftNote: note }),
    startRedraft: () => {
      const { detail, redraftNote } = state;
      if (detail === null || redraftNote === null || redraftNote.trim().length === 0) {
        return Promise.resolve();
      }
      // A reply redraft discards this card first, so read it again after.
      return dispatch(
        {
          action: "redraft",
          activityId: detail.activityId,
          expectedHash: detail.contentHash,
          note: redraftNote,
        },
        load,
      );
    },
  };
}
