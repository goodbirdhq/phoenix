import { describe, expect, it } from "vite-plus/test";

import { salesDateTime, salesDay, salesTime, staleReadNote } from "./time.ts";

describe("salesTime", () => {
  const options = { localZone: "America/Los_Angeles", locale: "en-US" } as const;
  const now = Date.parse("2026-11-09T18:30:00.000Z");

  it("adds the contact's clock when it reads differently", () => {
    expect(
      salesTime("2026-11-09T17:23:00.000Z", now, { ...options, theirZone: "Europe/London" }),
    ).toEqual({ local: "9:23 AM", theirs: "5:23 PM their time" });
  });

  it("leaves it out for a contact on the viewer's clock, or with no zone it knows", () => {
    for (const theirZone of ["America/Los_Angeles", "Not/AZone", null]) {
      expect(salesTime("2026-11-09T17:23:00.000Z", now, { ...options, theirZone })?.theirs).toBe(
        null,
      );
    }
  });

  it("names the day when it is not today, on either clock", () => {
    const tokyo = { ...options, theirZone: "Asia/Tokyo" };
    expect(salesTime("2026-11-10T07:00:00.000Z", now, tokyo)).toEqual({
      local: "11:00 PM",
      theirs: "Tue 4:00 PM their time",
    });
    expect(salesTime("2026-11-10T09:00:00.000Z", now, tokyo)).toEqual({
      local: "Tue 1:00 AM",
      theirs: "6:00 PM their time",
    });
  });

  it("reads nothing into a missing time", () => {
    expect(salesTime(null, now)).toBeNull();
    expect(salesTime("not a time", now)).toBeNull();
    expect(salesDateTime(null)).toBeNull();
    expect(staleReadNote(null, now)).toBeNull();
  });
});

describe("dates", () => {
  it("reads an engine day as a calendar day, whatever the viewer's zone", () => {
    expect(salesDay("2026-11-12", "en-GB")).toBe("Thu 12 Nov");
    expect(salesDay("not a day")).toBe("not a day");
  });

  it("dates a moment in a history", () => {
    expect(salesDateTime("2026-11-09T17:23:00.000Z", "en-US")).toMatch(/^Nov 9, \d{1,2}:23 [AP]M$/);
  });
});
