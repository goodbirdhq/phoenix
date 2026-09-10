import { describe, expect, it } from "vite-plus/test";
import { threadCompletionSeenAt } from "./threadCompletionSeen";
import { projectThreadContentPresentation } from "./threadContentPresentation";

const OLD = "2026-09-10T10:00:00.000Z";
const NEW = "2026-09-10T11:00:00.000Z";
const viewing = {
  enabled: true,
  visible: true,
  foreground: true,
  completedAt: NEW,
  lastVisitedAt: OLD,
};

describe("seen completions", () => {
  it("does not write read state while attention ordering is disabled", () => {
    expect(threadCompletionSeenAt({ ...viewing, enabled: false })).toBeNull();
  });
  it("only acknowledges visible foreground completions and never moves backwards", () => {
    expect(threadCompletionSeenAt({ ...viewing, visible: false })).toBeNull();
    expect(threadCompletionSeenAt({ ...viewing, foreground: false })).toBeNull();
    expect(threadCompletionSeenAt({ ...viewing, completedAt: "invalid" })).toBeNull();
    expect(threadCompletionSeenAt({ ...viewing, lastVisitedAt: NEW })).toBeNull();
    expect(threadCompletionSeenAt({ ...viewing, completedAt: OLD, lastVisitedAt: NEW })).toBeNull();
    expect(threadCompletionSeenAt(viewing)).toBe(NEW);
  });
  it("keeps the newer shell result unread until matching conversation detail loads", () => {
    const presentation = (detailCompletedAt: string) =>
      projectThreadContentPresentation({
        hasDetail: true,
        detailError: null,
        detailDeleted: false,
        connectionState: "reconnecting",
        detailCompletedAt,
      });
    const oldDetail = presentation(OLD);
    expect(oldDetail).toEqual({ kind: "ready", completedAt: OLD });
    if (oldDetail.kind !== "ready") throw new Error("Expected cached detail");
    expect(threadCompletionSeenAt({ ...viewing, completedAt: oldDetail.completedAt })).toBeNull();
    const refreshed = presentation(NEW);
    if (refreshed.kind !== "ready") throw new Error("Expected refreshed detail");
    expect(threadCompletionSeenAt({ ...viewing, completedAt: refreshed.completedAt })).toBe(NEW);
  });
});
