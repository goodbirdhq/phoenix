import { ThreadId } from "@t3tools/contracts";
import { COMPOSER_CONTEXT_CLIPBOARD_MIME } from "@t3tools/shared/composerContextClipboard";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";
import { describe, expect, it } from "vite-plus/test";

import {
  asKnownContextRecord,
  identicalComposerContextImportId,
  terminalContextDraftFromRecord,
  terminalContextRecord,
} from "../lib/composerContextRecords";
import { importPastedComposerText } from "./composerInlineTokenPaste";

function clipboard(text: string, extra: Record<string, string> = {}) {
  return {
    getData: (type: string) => (type === "text/plain" ? text : (extra[type] ?? "")),
  };
}

describe("importPastedComposerText", () => {
  it("rewrites a deduplicated legacy context chip to the draft's canonical id", () => {
    const copied = upgradeLegacyContextMessage(
      "Inspect this\n\n<terminal_context>\n- Terminal 1 line 1:\n  1 | output\n</terminal_context>",
    );
    const imported = asKnownContextRecord(copied.records[0]);
    if (!imported || imported.kind !== "terminal") throw new Error("Expected terminal context");
    const canonical = terminalContextRecord(
      terminalContextDraftFromRecord(imported, ThreadId.make("thread-destination")),
    );
    const data = clipboard(copied.text, {
      [COMPOSER_CONTEXT_CLIPBOARD_MIME]: JSON.stringify({
        version: 1,
        source: { environmentId: "env-1" },
        records: [imported],
      }),
    });

    const text = importPastedComposerText(data, (fragment) => {
      const record = asKnownContextRecord(fragment.records[0]);
      if (!record) return new Map();
      const canonicalId = identicalComposerContextImportId(
        record,
        new Map([[canonical.contextId, canonical]]),
        (existing) => existing,
      );
      return canonicalId ? new Map([[record.contextId, canonicalId]]) : new Map();
    });

    expect(text).toContain(`t3-context://v1/terminal/${canonical.contextId}`);
    expect(text).not.toContain(`t3-context://v1/terminal/${imported.contextId}`);
  });
});
