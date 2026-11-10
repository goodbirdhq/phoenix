import { describe, expect, it } from "vite-plus/test";

import { createRowActions } from "./rowActions.ts";

describe("createRowActions", () => {
  it("marks a row busy until its answer lands, then shows the answer", async () => {
    const rows = createRowActions<string>();
    let answer: (value: string) => void = () => {};
    const running = rows.run("a", "scheduled", () => new Promise((resolve) => (answer = resolve)));
    expect(rows.busy("a")).toBe(true);
    expect(rows.busy("b")).toBe(false);
    answer("Paused");
    await running;
    expect(rows.busy("a")).toBe(false);
    expect(rows.outcome("a", "scheduled")).toBe("Paused");
  });

  it("drops an answer for good once the list shows the row in another state", async () => {
    const rows = createRowActions<string>();
    await rows.run("a", "scheduled", async () => "Paused");
    expect(rows.outcome("a", "paused")).toBeNull();
    // Back in the state it was pressed in, the old answer is still gone.
    expect(rows.outcome("a", "scheduled")).toBeNull();
  });

  it("keeps only the answers `keep` asks for", async () => {
    const rows = createRowActions<string>();
    const keep = (outcome: string) => outcome === "failed";
    await rows.run("a", "scheduled", async () => "done", keep);
    await rows.run("b", "scheduled", async () => "failed", keep);
    expect(rows.outcome("a", "scheduled")).toBeNull();
    expect(rows.outcome("b", "scheduled")).toBe("failed");
  });

  it("tells subscribers each time busy or an answer changes", async () => {
    const rows = createRowActions<string>();
    const versions: number[] = [];
    rows.subscribe(() => versions.push(rows.getVersion()));
    await rows.run("a", "scheduled", async () => "Paused");
    expect(versions).toEqual([1, 2]);
  });
});
