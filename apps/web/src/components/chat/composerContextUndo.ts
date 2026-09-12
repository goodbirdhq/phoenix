import type { ComposerContextRecord, PreviewAnnotationPayload } from "@t3tools/contracts";

import type {
  ComposerFileAttachment,
  ComposerImageAttachment,
  ComposerThreadDraftState,
  ComposerThreadTarget,
} from "../../composerDraftStore";
import { collectInlineContextIds } from "../../lib/composerContextReferences";
import { fileContextReference, previewAnnotationContextId } from "../../lib/composerContextRecords";
import { toKindScopedComposerContextId } from "../../lib/composerContextReferences";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { ReviewCommentContext } from "../../reviewCommentContext";

interface RetainedPreviewAnnotation {
  annotation: PreviewAnnotationPayload;
  image: ComposerImageAttachment | undefined;
}

export interface RetainedAttachmentContextPayloads {
  files: Map<string, ComposerFileAttachment>;
  previewAnnotations: Map<string, RetainedPreviewAnnotation>;
}

export interface TargetBoundComposerContextRecovery {
  readonly targetKey: string;
  readonly contexts: {
    readonly terminals: Map<string, TerminalContextDraft>;
    readonly reviewComments: Map<string, ReviewCommentContext>;
  };
  readonly attachments: RetainedAttachmentContextPayloads;
}

export function composerContextRecoveryForTarget(
  current: TargetBoundComposerContextRecovery | undefined,
  targetKey: string,
): TargetBoundComposerContextRecovery {
  if (current?.targetKey === targetKey) return current;
  return {
    targetKey,
    contexts: { terminals: new Map(), reviewComments: new Map() },
    attachments: { files: new Map(), previewAnnotations: new Map() },
  };
}

type ImportedAttachmentRecord = Extract<ComposerContextRecord, { kind: "image" | "file" }>;

/**
 * Completes an asynchronous clipboard attachment import against the draft that started it.
 * The prompt may have changed while the bytes downloaded, so only attach them while the
 * original reference (or an annotation that owns the screenshot) is still live.
 */
export function commitImportedAttachment(input: {
  readonly record: ImportedAttachmentRecord;
  readonly localId: string;
  readonly file: File;
  readonly target: ComposerThreadTarget;
  readonly getDraft: (target: ComposerThreadTarget) => ComposerThreadDraftState | null;
  readonly addImages: (target: ComposerThreadTarget, images: ComposerImageAttachment[]) => string[];
  readonly addFiles: (
    target: ComposerThreadTarget,
    files: ComposerFileAttachment[],
    options?: { appendReference?: boolean },
  ) => string[];
  readonly createPreviewUrl?: (file: File) => string;
}): "accepted" | "reference-removed" | "rejected" {
  const draft = input.getDraft(input.target);
  if (!draft) return "reference-removed";
  const referenced = new Set(collectInlineContextIds(draft.prompt));
  const directContextId = toKindScopedComposerContextId(input.record.kind, input.localId);
  const annotationOwnsImage =
    input.record.kind === "image" &&
    draft.previewAnnotations.some(
      (annotation) =>
        annotation.id === input.localId &&
        referenced.has(previewAnnotationContextId(annotation.id)),
    );
  if (!referenced.has(directContextId) && !annotationOwnsImage) return "reference-removed";

  const accepted =
    input.record.kind === "image"
      ? input.addImages(input.target, [
          {
            type: "image",
            id: input.localId,
            name: input.record.name,
            mimeType: input.file.type,
            sizeBytes: input.file.size,
            previewUrl: (input.createPreviewUrl ?? URL.createObjectURL)(input.file),
            file: input.file,
          },
        ])
      : input.addFiles(
          input.target,
          [
            {
              type: "file",
              id: input.localId,
              name: input.record.name,
              mimeType: input.file.type,
              sizeBytes: input.file.size,
              file: input.file,
            },
          ],
          { appendReference: false },
        );
  return accepted.includes(input.localId) ? "accepted" : "rejected";
}

export function reconcileAttachmentContextReferences(input: {
  referencedContextIds: ReadonlySet<string>;
  files: ReadonlyArray<ComposerFileAttachment>;
  images: ReadonlyArray<ComposerImageAttachment>;
  previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  retained: RetainedAttachmentContextPayloads;
}): {
  filesToRemove: string[];
  filesToRestore: ComposerFileAttachment[];
  annotationIdsToRemove: string[];
  annotationsToRestore: RetainedPreviewAnnotation[];
} {
  const liveFileContextIds = new Set<string>(
    input.files.map((file) => fileContextReference(file).contextId),
  );
  const filesToRemove: string[] = [];
  for (const file of input.files) {
    const contextId = fileContextReference(file).contextId;
    if (input.referencedContextIds.has(contextId)) continue;
    input.retained.files.set(contextId, file);
    filesToRemove.push(file.id);
  }
  const filesToRestore = [...input.referencedContextIds].flatMap((contextId) => {
    if (liveFileContextIds.has(contextId)) return [];
    const file = input.retained.files.get(contextId);
    return file ? [file] : [];
  });

  const imagesById = new Map(input.images.map((image) => [image.id, image]));
  const liveAnnotationContextIds = new Set<string>(
    input.previewAnnotations.map((annotation) => previewAnnotationContextId(annotation.id)),
  );
  const annotationIdsToRemove: string[] = [];
  for (const annotation of input.previewAnnotations) {
    const contextId = previewAnnotationContextId(annotation.id);
    if (input.referencedContextIds.has(contextId)) continue;
    input.retained.previewAnnotations.set(contextId, {
      annotation,
      image: imagesById.get(annotation.id),
    });
    annotationIdsToRemove.push(annotation.id);
  }
  const annotationsToRestore = [...input.referencedContextIds].flatMap((contextId) => {
    if (liveAnnotationContextIds.has(contextId)) return [];
    const retained = input.retained.previewAnnotations.get(contextId);
    return retained ? [retained] : [];
  });

  return { filesToRemove, filesToRestore, annotationIdsToRemove, annotationsToRestore };
}
