import * as Schema from "effect/Schema";

const CodexCursor = Schema.Struct({ threadId: Schema.NonEmptyString });
const ClaudeCursor = Schema.Struct({ resume: Schema.NonEmptyString });
const AcpCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.NonEmptyString,
});

const isCodexCursor = Schema.is(CodexCursor);
const isClaudeCursor = Schema.is(ClaudeCursor);
const isAcpCursor = Schema.is(AcpCursor);

/** Native transcript identity, never the Phoenix thread id in a Claude cursor. */
export function usageSessionIdentity(provider: string, cursor: unknown): string | null {
  switch (provider) {
    case "codex":
      return isCodexCursor(cursor) ? cursor.threadId : null;
    case "claudeAgent":
      return isClaudeCursor(cursor) ? cursor.resume : null;
    case "opencode":
    case "grok":
      return isAcpCursor(cursor) ? cursor.sessionId : null;
    default:
      return null;
  }
}
