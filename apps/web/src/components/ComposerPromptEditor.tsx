import { ComposerPromptEditorTiptap } from "./ComposerPromptEditorTiptap";
import type { ComposerPromptEditorProps as ComposerPromptEditorTiptapProps } from "./ComposerPromptEditorTiptap";

export type {
  ComposerCitationCommentRequest,
  ComposerPromptEditorHandle,
} from "./ComposerPromptEditorTiptap";

export interface ComposerPromptEditorProps extends ComposerPromptEditorTiptapProps {
  /**
   * Stable identity for the draft whose undo history this editor owns. The
   * composer outlives thread switches, so a new key remounts the editor and
   * undo can never replay one draft's edits into another.
   */
  historyKey: string;
}

/**
 * The composer editor. Tiptap in both modes: the `richTextEnabled` setting
 * toggles Markdown styling, never the engine. Plain mode renders every
 * marker as a literal character and serializes byte-identically.
 */
export function ComposerPromptEditor({ historyKey, ...props }: ComposerPromptEditorProps) {
  return <ComposerPromptEditorTiptap key={historyKey} {...props} />;
}
