import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  SALES_TASK_OUTCOMES,
  SalesActionError,
  SalesCardState,
  SalesHoldResult,
  SalesTask,
  SalesTaskOutcome,
  SalesTaskReport,
  SalesTaskReportInput,
  salesDispatchThreadPrefix,
  salesEngineKey,
  salesEngineRoot,
} from "./sales.ts";

describe("salesEngineRoot", () => {
  it("reads the origin and the API base as the same engine", () => {
    for (const entered of [
      "https://engine.example.com",
      " https://engine.example.com/ ",
      "https://engine.example.com/api/sales/v1",
      "https://engine.example.com/api/sales/v1//",
    ]) {
      expect(salesEngineRoot(entered)).toBe("https://engine.example.com");
    }
  });

  it("keeps a path the engine sits under", () => {
    expect(salesEngineRoot("https://example.com/birdhouse/api/sales/v1/")).toBe(
      "https://example.com/birdhouse",
    );
  });

  it("refuses anything but an http or https URL", () => {
    expect(salesEngineRoot("ftp://engine.example.com")).toBeNull();
    expect(salesEngineRoot("engine.example.com")).toBeNull();
    expect(salesEngineRoot("")).toBeNull();
  });
});

describe("salesEngineKey", () => {
  it("gives one key for every spelling of one engine", () => {
    expect(
      new Set(
        [
          "https://engine.example.com",
          "HTTPS://Engine.Example.com/",
          "https://engine.example.com/api/sales/v1",
        ].map(salesEngineKey),
      ),
    ).toEqual(new Set(["https://engine.example.com"]));
  });

  it("tells different engines apart", () => {
    expect(salesEngineKey("https://engine.example.com")).not.toBe(
      salesEngineKey("https://other.example.com"),
    );
  });

  it("keys text that is not a URL as itself", () => {
    expect(salesEngineKey("  Not A URL ")).toBe("not a url");
  });
});

const decodeSalesActionError = Schema.decodeUnknownSync(SalesActionError);

describe("SalesActionError", () => {
  it("reads a failure from a server without origins as the transport's, which claims least", () => {
    const error = decodeSalesActionError({
      _tag: "SalesActionError",
      reason: "not-configured",
      message: "Not set up.",
      currentHash: null,
      state: null,
    });
    expect(error.origin).toBe("transport");
  });
});

describe("dispatch thread ids", () => {
  it("keeps one card's prefix from matching another's", () => {
    const id = `${salesDispatchThreadPrefix({ activityId: "act-10" })}t1`;
    expect(id.startsWith(salesDispatchThreadPrefix({ activityId: "act-1" }))).toBe(false);
    expect(
      `${salesDispatchThreadPrefix({ activityId: "a:b" })}t1`.startsWith(
        salesDispatchThreadPrefix({ activityId: "a" }),
      ),
    ).toBe(false);
  });
});

const decodeCardState = Schema.decodeUnknownSync(SalesCardState);
const decodeHoldResult = Schema.decodeUnknownSync(SalesHoldResult);
const decodeTaskReport = Schema.decodeUnknownSync(SalesTaskReport);
const decodeTask = Schema.decodeUnknownSync(SalesTask);

describe("Hold, Resume and task reports", () => {
  const card = {
    activityId: "act-1",
    contentHash: "a".repeat(64),
    state: "open",
    approved: false,
    approvedBy: null,
  };

  it("reads a card's pause and send status, and an engine that sends neither", () => {
    const decode = decodeCardState;
    expect(
      decode({
        ...card,
        paused: { by: "phoenix", at: "2026-11-10T08:00:00Z" },
        sendStatus: "claimed",
      }),
    ).toMatchObject({ paused: { by: "phoenix" }, sendStatus: "claimed" });
    expect(decode(card)).toMatchObject({ paused: null, sendStatus: null });
  });

  it("knows Hold's two results and no others", () => {
    const decode = decodeHoldResult;
    expect(decode({ card, already: true, result: "unapproved" }).result).toBe("unapproved");
    expect(() => decode({ card, already: false, result: "stopped" })).toThrow();
  });

  it("offers only outcomes the report accepts", () => {
    const isOutcome = Schema.is(SalesTaskOutcome);
    for (const outcomes of Object.values(SALES_TASK_OUTCOMES)) {
      expect(outcomes.every(isOutcome)).toBe(true);
    }
  });

  it("refuses a task id a URL would resolve out of its path segment", () => {
    const isInput = Schema.is(SalesTaskReportInput);
    for (const taskId of ["", ".", ".."]) {
      expect(isInput({ taskId, outcome: "skip" })).toBe(false);
    }
    for (const taskId of ["01JC8Z", "task/1", "..."]) {
      expect(isInput({ taskId, outcome: "skip" })).toBe(true);
    }
  });

  it("reads a report's open result and its budget, and a task with no budget place", () => {
    const report = decodeTaskReport({
      ok: true,
      result: "backlog_paused",
      task: { id: "t1", action: "connect", status: "pending", logged: false },
      budget: { day: "2026-11-10", dailyLimit: 7, available: 0, sentToday: 7 },
    });
    expect(report).toMatchObject({
      result: "backlog_paused",
      reason: null,
      task: { outcome: null },
      budget: { day: "2026-11-10", dailyLimit: 7, available: 0 },
    });
    const task = decodeTask({ id: "t1", action: "connect", status: "pending" });
    expect(task.admittedOn).toBeNull();
  });

  it("carries Resume's and a report's refusals over the wire", () => {
    for (const reason of ["needs_press", "chase_cap", "refused", "not_offered", "not_admitted"]) {
      const error = decodeSalesActionError({
        _tag: "SalesActionError",
        origin: "engine",
        reason,
        message: "Refused.",
        currentHash: null,
        state: null,
      });
      expect(error.reason).toBe(reason);
    }
  });
});
