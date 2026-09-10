import { create } from "zustand";

export interface PullRequestEditDraft {
  readonly title: string;
  readonly body: string;
}

/** Drafts belong to an environment, repository and PR; route Back must not discard them. */
export const usePullRequestEditDrafts = create<{
  drafts: Record<string, PullRequestEditDraft>;
  save: (key: string, draft: PullRequestEditDraft, published?: PullRequestEditDraft) => void;
  discard: (key: string, submitted?: PullRequestEditDraft) => void;
}>((set) => ({
  drafts: {},
  save: (key, draft, published) =>
    set((state) => {
      if (published && draft.title === published.title && draft.body === published.body) {
        const drafts = { ...state.drafts };
        delete drafts[key];
        return { drafts };
      }
      return { drafts: { ...state.drafts, [key]: draft } };
    }),
  discard: (key, submitted) =>
    set((state) => {
      const current = state.drafts[key];
      if (
        submitted &&
        current &&
        (current.title !== submitted.title || current.body !== submitted.body)
      )
        return state;
      const drafts = { ...state.drafts };
      delete drafts[key];
      return { drafts };
    }),
}));
