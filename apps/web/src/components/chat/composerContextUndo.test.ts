import {
  ComposerContextId,
  EnvironmentId,
  ThreadId,
  type PreviewAnnotationPayload,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type {
  ComposerFileAttachment,
  ComposerImageAttachment,
  ComposerThreadDraftState,
} from "../../composerDraftStore";
import {
  buildMessageContext,
  fileContextReference,
  previewAnnotationContextId,
} from "../../lib/composerContextRecords";
import {
  commitImportedAttachment,
  composerContextRecoveryForTarget,
  reconcileAttachmentContextReferences,
  type RetainedAttachmentContextPayloads,
} from "./composerContextUndo";

const binary = new File(["binary"], "context.png", { type: "image/png" });
const file = {
  type: "file",
  id: "file-1",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
  file: new File(["notes"], "notes.txt", { type: "text/plain" }),
} satisfies ComposerFileAttachment;
const image = {
  type: "image",
  id: "annotation-1",
  name: "annotation.png",
  mimeType: "image/png",
  sizeBytes: binary.size,
  previewUrl: "blob:annotation",
  file: binary,
} satisfies ComposerImageAttachment;
const annotation = {
  id: "annotation-1",
  pageUrl: "https://example.com",
  pageTitle: "Example",
  comment: "Fix this",
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: {
    dataUrl: "data:image/png;base64,YmluYXJ5",
    width: 1,
    height: 1,
    cropRect: { x: 0, y: 0, width: 1, height: 1 },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
} satisfies PreviewAnnotationPayload;

function retention(): RetainedAttachmentContextPayloads {
  return { files: new Map(), previewAnnotations: new Map() };
}

function draft(
  prompt: string,
  previewAnnotations: PreviewAnnotationPayload[] = [],
): ComposerThreadDraftState {
  return {
    prompt,
    images: [],
    files: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    previewAnnotations,
    reviewComments: [],
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
  };
}

describe("composerContextRecoveryForTarget", () => {
  it("preserves same-target undo payloads and discards them at a target boundary", () => {
    const threadA = composerContextRecoveryForTarget(undefined, "remote-a:thread-a");
    threadA.contexts.terminals.set("terminal-a", {
      id: "a",
      threadId: ThreadId.make("thread-a"),
      terminalId: "default",
      terminalLabel: "Terminal",
      lineStart: 1,
      lineEnd: 1,
      text: "secret a",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    threadA.attachments.files.set("file-a", file);

    expect(composerContextRecoveryForTarget(threadA, "remote-a:thread-a")).toBe(threadA);
    const threadB = composerContextRecoveryForTarget(threadA, "remote-b:thread-b");
    expect(threadB).not.toBe(threadA);
    expect(threadB.contexts.terminals.size).toBe(0);
    expect(threadB.attachments.files.size).toBe(0);
  });
});

describe("commitImportedAttachment", () => {
  const originalTarget = {
    environmentId: EnvironmentId.make("remote-a"),
    threadId: ThreadId.make("thread-a"),
  };
  const importedFile = new File(["notes"], "notes.txt", { type: "text/plain" });
  const fileRecord = {
    version: 1,
    kind: "file",
    contextId: ComposerContextId.make("file_source"),
    label: "notes.txt",
    attachmentId: "attachment-source",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
  } as const;

  it("finishes on the original remote target after the visible composer switches", () => {
    const addFiles = vi.fn(() => ["local-file"]);
    const getDraft = vi.fn((target) => {
      expect(target).toBe(originalTarget);
      return draft("[notes](t3-context://v1/file/file_local-file)");
    });

    expect(
      commitImportedAttachment({
        record: fileRecord,
        localId: "local-file",
        file: importedFile,
        target: originalTarget,
        getDraft,
        addImages: vi.fn(() => []),
        addFiles,
      }),
    ).toBe("accepted");
    expect(addFiles).toHaveBeenCalledWith(
      originalTarget,
      [expect.objectContaining({ id: "local-file", file: importedFile })],
      { appendReference: false },
    );
  });

  it("does not resurrect bytes after the original target deleted the chip", () => {
    const addFiles = vi.fn(() => ["local-file"]);
    expect(
      commitImportedAttachment({
        record: fileRecord,
        localId: "local-file",
        file: importedFile,
        target: originalTarget,
        getDraft: () => draft("chip removed"),
        addImages: vi.fn(() => []),
        addFiles,
      }),
    ).toBe("reference-removed");
    expect(addFiles).not.toHaveBeenCalled();
  });

  it("keeps an imported screenshot while its annotation reference still exists", () => {
    const addImages = vi.fn(() => [annotation.id]);
    expect(
      commitImportedAttachment({
        record: {
          ...fileRecord,
          kind: "image",
          contextId: ComposerContextId.make("image_source"),
        },
        localId: annotation.id,
        file: binary,
        target: originalTarget,
        getDraft: () =>
          draft(
            `[Fix this](t3-context://v1/preview-annotation/${previewAnnotationContextId(annotation.id)})`,
            [annotation],
          ),
        addImages,
        addFiles: vi.fn(() => []),
        createPreviewUrl: () => "blob:imported-annotation",
      }),
    ).toBe("accepted");
    expect(addImages).toHaveBeenCalledWith(originalTarget, [
      expect.objectContaining({ id: annotation.id, previewUrl: "blob:imported-annotation" }),
    ]);
  });
});

describe("reconcileAttachmentContextReferences", () => {
  it("restores file bytes after deleting and undoing its chip", () => {
    const retained = retention();
    const removed = reconcileAttachmentContextReferences({
      referencedContextIds: new Set(),
      files: [file],
      images: [],
      previewAnnotations: [],
      retained,
    });
    expect(removed.filesToRemove).toEqual(["file-1"]);

    const restored = reconcileAttachmentContextReferences({
      referencedContextIds: new Set([fileContextReference(file).contextId]),
      files: [],
      images: [],
      previewAnnotations: [],
      retained,
    });
    expect(restored.filesToRestore).toEqual([file]);
    expect(restored.filesToRestore[0]?.file).toBe(file.file);
    expect(
      buildMessageContext({
        terminalContexts: [],
        reviewComments: [],
        previewAnnotations: [],
        attachments: [{ attachment: restored.filesToRestore[0]!, attachmentId: "uploaded-file" }],
      })?.records,
    ).toEqual([
      expect.objectContaining({
        kind: "file",
        contextId: "file_file-1",
        attachmentId: "uploaded-file",
      }),
    ]);
  });

  it("restores an annotation and its screenshot attachment after undo", () => {
    const retained = retention();
    const removed = reconcileAttachmentContextReferences({
      referencedContextIds: new Set(),
      files: [],
      images: [image],
      previewAnnotations: [annotation],
      retained,
    });
    expect(removed.annotationIdsToRemove).toEqual(["annotation-1"]);

    const restored = reconcileAttachmentContextReferences({
      referencedContextIds: new Set([previewAnnotationContextId(annotation.id)]),
      files: [],
      images: [],
      previewAnnotations: [],
      retained,
    });
    expect(restored.annotationsToRestore).toEqual([{ annotation, image }]);
    expect(restored.annotationsToRestore[0]?.annotation.screenshot?.dataUrl).toBe(
      "data:image/png;base64,YmluYXJ5",
    );
    expect(restored.annotationsToRestore[0]?.image?.file).toBe(binary);
    expect(
      buildMessageContext({
        terminalContexts: [],
        reviewComments: [],
        previewAnnotations: restored.annotationsToRestore.map((entry) => entry.annotation),
        attachments: [
          {
            attachment: restored.annotationsToRestore[0]!.image!,
            attachmentId: "uploaded-screenshot",
          },
        ],
      })?.records,
    ).toEqual([
      expect.objectContaining({
        kind: "preview-annotation",
        screenshotContextId: "image_annotation-1",
      }),
      expect.objectContaining({
        kind: "image",
        contextId: "image_annotation-1",
        attachmentId: "uploaded-screenshot",
      }),
    ]);
  });
});
