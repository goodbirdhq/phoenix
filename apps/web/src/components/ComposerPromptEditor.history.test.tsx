// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY_RECORDS = new Map();
const noop = () => {};

let container: HTMLDivElement;
let root: Root;
const editorRef = createRef<ComposerPromptEditorHandle>();
const drafts = new Map<string, string>();
let activeKey = "thread-a";

function render() {
  const value = drafts.get(activeKey) ?? "";
  root.render(
    <ComposerPromptEditor
      editorRef={editorRef}
      historyKey={activeKey}
      value={value}
      cursor={value.length}
      contextRecords={EMPTY_RECORDS}
      skills={[]}
      disabled={false}
      placeholder=""
      onChange={(next) => {
        drafts.set(activeKey, next);
        render();
      }}
      onPaste={noop}
    />,
  );
}

async function openDraft(key: string) {
  activeKey = key;
  await act(async () => render());
}

function tiptap(): Editor {
  const dom = container.querySelector(".ProseMirror") as (HTMLElement & { editor?: Editor }) | null;
  if (!dom?.editor) throw new Error("Tiptap editor did not mount");
  return dom.editor;
}

async function type(text: string) {
  await act(async () => {
    tiptap().commands.insertContent(text);
  });
}

beforeEach(() => {
  drafts.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("ComposerPromptEditor history", () => {
  it("never replays one draft's undo history into another draft", async () => {
    drafts.set("thread-b", "B draft");
    await openDraft("thread-a");
    await type("A one");

    await openDraft("thread-b");
    await act(async () => {
      tiptap().commands.undo();
    });
    expect(editorRef.current?.readSnapshot().value).toBe("B draft");
    expect(drafts.get("thread-b")).toBe("B draft");
    expect(drafts.get("thread-a")).toBe("A one");
  });

  it("keeps the editor and its history while the same draft updates", async () => {
    await openDraft("thread-a");
    await type("A one");
    await act(async () => {
      tiptap().commands.undo();
    });
    expect(drafts.get("thread-a")).toBe("");
  });
});
