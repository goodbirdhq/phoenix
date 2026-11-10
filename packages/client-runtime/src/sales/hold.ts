import type { SalesHoldResult, SalesResumeResult } from "@t3tools/contracts";
import type { AsyncResult } from "effect/unstable/reactivity";

import type { AtomCommandResult } from "../state/runtime.ts";
import { readSalesFailure } from "./failure.ts";

/** What Hold or Resume did, told truthfully: a send already under way is never called stopped. */
export interface SalesHoldOutcome {
  /**
   * - `done`: it did what was asked.
   * - `already`: it stood that way already.
   * - `withdrawn`: a Hold on a person's approval took it back for good; no Resume brings it back.
   * - `going`: the send was already under way when held, so it was not stopped.
   * - `failed`: the engine or Phoenix refused, or the outcome is unknown.
   */
  readonly kind: "done" | "already" | "withdrawn" | "going" | "failed";
  readonly tone: "success" | "warning" | "error";
  readonly title: string;
  readonly description: string;
  /** Only a person's approval sends it now: offer the draft in Outreach. */
  readonly needsPress: boolean;
}

const outcome = (
  kind: SalesHoldOutcome["kind"],
  tone: SalesHoldOutcome["tone"],
  title: string,
  description: string,
  needsPress = false,
): SalesHoldOutcome => ({ kind, tone, title, description, needsPress });

const RESUME_HINT = "Resume gives it back to the autopilot.";

/** A refused Hold or Resume. `needs_press` and `chase_cap` leave it paused: a warning. */
export function failedOutcome(result: AsyncResult.Failure<unknown, unknown>): SalesHoldOutcome {
  const failure = readSalesFailure(result);
  const attention = failure.reason === "needs_press" || failure.reason === "chase_cap";
  return outcome(
    "failed",
    attention ? "warning" : "error",
    failure.title,
    failure.description,
    failure.reason === "needs_press",
  );
}

/** What a Hold did, from the engine's answer. */
export function holdOutcome(result: AtomCommandResult<SalesHoldResult, unknown>): SalesHoldOutcome {
  if (result._tag !== "Success") return failedOutcome(result);
  const { card, already } = result.value;
  if (card.sendStatus === "claimed") {
    return outcome(
      "going",
      "warning",
      "Already going",
      "It was already being sent, so holding it could not stop it.",
    );
  }
  if (result.value.result === "unapproved") {
    return outcome(
      "withdrawn",
      "success",
      "Approval withdrawn",
      "It goes only once you approve it again.",
    );
  }
  return already
    ? outcome("already", "success", "Already paused", RESUME_HINT)
    : outcome("done", "success", "Paused", RESUME_HINT);
}

/** What a Resume did, from the engine's answer. */
export function resumeOutcome(
  result: AtomCommandResult<SalesResumeResult, unknown>,
): SalesHoldOutcome {
  if (result._tag !== "Success") return failedOutcome(result);
  const { card, already } = result.value;
  const goes = card.goes ? `It goes ${card.goes}.` : "The autopilot sends it at its slot.";
  return already
    ? outcome("already", "success", "Already resumed", goes)
    : outcome("done", "success", "Resumed", goes);
}
