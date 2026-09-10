import { beforeEach, describe, expect, it } from "vite-plus/test";
import { usePullRequestEditDrafts } from "./pullRequestEditDrafts";

describe("pull request editing drafts", () => {
  beforeEach(() => usePullRequestEditDrafts.setState({ drafts: {} }));

  it("retains a draft while another environment's copy is edited and discarded", () => {
    const store = usePullRequestEditDrafts.getState();
    const first = { title: "First title", body: "Keep this description" };
    store.save('["laptop","project","repo",1]', first);
    store.save('["server","project","repo",1]', {
      title: "Other title",
      body: "Other description",
    });
    store.discard('["server","project","repo",1]');
    expect(usePullRequestEditDrafts.getState().drafts['["laptop","project","repo",1]']).toEqual(
      first,
    );
  });

  it("does not discard edits made after a save started", () => {
    const store = usePullRequestEditDrafts.getState();
    const submitted = { title: "Title", body: "Submitted" };
    store.save("pr", submitted);
    store.save("pr", { ...submitted, body: "Revised after navigating back" });
    store.discard("pr", submitted);
    expect(usePullRequestEditDrafts.getState().drafts.pr?.body).toBe(
      "Revised after navigating back",
    );
  });

  it("clears title and description together after a successful save", () => {
    const store = usePullRequestEditDrafts.getState();
    const submitted = { title: "Title", body: "" };
    store.save("pr", submitted);
    store.discard("pr", submitted);
    expect(usePullRequestEditDrafts.getState().drafts.pr).toBeUndefined();
  });

  it("drops reverted edits so reopening uses the latest published values", () => {
    const store = usePullRequestEditDrafts.getState();
    const published = { title: "Original title", body: "Original description" };
    store.save("pr", { ...published, title: "Draft title" }, published);
    store.save("pr", { title: published.title, body: "Draft description" }, published);
    expect(usePullRequestEditDrafts.getState().drafts.pr?.body).toBe("Draft description");
    store.save("pr", published, published);
    expect(usePullRequestEditDrafts.getState().drafts.pr).toBeUndefined();
  });
});
