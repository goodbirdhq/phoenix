/**
 * Text in a draft that would not show as it is sent. A person signs exactly the To, subject and
 * body they read, so anything an agent could put there that a reader cannot see breaks that:
 * invisible and format characters (zero-width, bidi controls that reorder what is shown, soft
 * hyphens, byte-order marks, tag characters), control characters, and walls of blank lines or
 * spaces that push a paragraph out of view. A To address is held to plain printable ASCII, since a
 * single look-alike letter (a Cyrillic "а") makes it another address, and telling a look-alike
 * from a real internationalised address needs confusable tables that still miss whole-script
 * fakes. An internationalised address cannot be approved here. Signing refuses a draft with any
 * finding (`verifyDisplayedVersion`); the preview marks each one (`markHiddenText`).
 * See docs/internals/sales-approvals.md.
 */

export type DraftField = "to" | "subject" | "body";

export interface HiddenTextFinding {
  readonly field: DraftField;
  readonly kind: "character" | "blank-lines" | "spaces";
  /** Where it is, as UTF-16 offsets into the field's text. */
  readonly start: number;
  readonly end: number;
  /** What the preview shows in its place, such as `⟨U+200B⟩`. */
  readonly token: string;
}

/** Up to this many blank lines in a row read as layout; more push text out of view. */
const MAX_BLANK_LINES = 3;
/** Up to this many spaces or tabs in a row read as layout; more are a wall. */
const MAX_SPACES = 15;

// Unicode's "Other" characters (control, format, surrogate, private use, unassigned), the line
// and paragraph separators, and the fillers that render as nothing. A zero-width joiner inside
// an emoji sequence (👩‍💻) is what makes the emoji, so it is allowed there.
const INVISIBLE =
  "(?!(?<=\\p{Extended_Pictographic}[\\uFE0F\\u{1F3FB}-\\u{1F3FF}]?)\\u200D\\p{Extended_Pictographic})" +
  "[\\p{C}\\p{Zl}\\p{Zp}\\u115F\\u1160\\u2800\\u3164\\uFFA0]";
const SPACES = `[^\\S\\r\\n]{${MAX_SPACES + 1},}`;

const PATTERNS: Record<DraftField, RegExp> = {
  // Anything outside printable ASCII, so a look-alike letter cannot pass for the address.
  to: /[^\x20-\x7E]/gu,
  subject: new RegExp(`(?<spaces>${SPACES})|${INVISIBLE}`, "gu"),
  // A body keeps its line breaks and tabs, and a CR only as part of a CRLF line ending.
  body: new RegExp(
    `(?<=^|\\n)(?<lines>(?:[^\\S\\n]*\\n){${MAX_BLANK_LINES + 1},})|(?<spaces>${SPACES})|` +
      `(?![\\n\\t]|\\r\\n)${INVISIBLE}`,
    "gu",
  ),
};

const codePoint = (char: string) =>
  `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

// The hash trims the To address and the subject (`computeContentHash`), so only what it keeps
// is scanned; offsets still count from the field as shown.
function findingsIn(field: DraftField, text: string): HiddenTextFinding[] {
  const kept = field === "body" ? text : text.trim();
  const offset = field === "body" ? 0 : text.indexOf(kept);
  return Array.from(kept.matchAll(PATTERNS[field]), (match): HiddenTextFinding => {
    const start = offset + match.index;
    const end = start + match[0].length;
    const { lines, spaces } = match.groups ?? {};
    if (lines !== undefined) {
      const count = lines.split("\n").length - 1;
      return { field, kind: "blank-lines", start, end, token: `⟨${count} blank lines⟩\n` };
    }
    if (spaces !== undefined) {
      return { field, kind: "spaces", start, end, token: `⟨${spaces.length} spaces⟩` };
    }
    return { field, kind: "character", start, end, token: `⟨${codePoint(match[0])}⟩` };
  });
}

/** Everything in a draft's To, subject and body that would not show as it is sent. */
export function hiddenTextFindings(draft: {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}): ReadonlyArray<HiddenTextFinding> {
  return [
    ...findingsIn("to", draft.to),
    ...findingsIn("subject", draft.subject),
    ...findingsIn("body", draft.body),
  ];
}

export interface MarkedSegment {
  /** The field's text, exactly: joined, the segments are the field. */
  readonly text: string;
  /** What to show instead, for a finding; null for text shown as it is. */
  readonly token: string | null;
}

/**
 * One field cut at its findings, for a preview that shows each finding as its token. With no
 * findings it is the text as one segment, so a clean draft is shown exactly as hashed.
 */
export function markHiddenText(
  text: string,
  findings: ReadonlyArray<HiddenTextFinding>,
): ReadonlyArray<MarkedSegment> {
  const segments: MarkedSegment[] = [];
  let at = 0;
  for (const { start, end, token } of findings) {
    if (start > at) segments.push({ text: text.slice(at, start), token: null });
    segments.push({ text: text.slice(start, end), token });
    at = end;
  }
  if (at < text.length || segments.length === 0) {
    segments.push({ text: text.slice(at), token: null });
  }
  return segments;
}

/** Where a finding is, for a person: "line 3 of the body". */
export function findingPlace(text: string, finding: HiddenTextFinding): string {
  if (finding.field !== "body") return `the ${finding.field === "to" ? "To address" : "subject"}`;
  const line = text.slice(0, finding.start).split("\n").length;
  return `line ${line} of the body`;
}

const LINE_BREAK = /^[\n\r\v\f\x85\u2028\u2029]$/u;

/**
 * A subject or body without its hidden characters, for an edit the person asks for: a character
 * nobody can see cannot be found and deleted by hand. A line break becomes a space in a subject
 * and a plain line break in a body; anything else hidden goes. Blank lines and spaces are left
 * alone, since an edit shows them.
 */
export function withoutHiddenCharacters(field: "subject" | "body", text: string): string {
  let out = "";
  let at = 0;
  for (const finding of findingsIn(field, text)) {
    if (finding.kind !== "character") continue;
    const char = text.slice(finding.start, finding.end);
    out += text.slice(at, finding.start);
    if (LINE_BREAK.test(char) || (field === "subject" && char === "\t")) {
      out += field === "subject" ? " " : "\n";
    }
    at = finding.end;
  }
  return out + text.slice(at);
}
