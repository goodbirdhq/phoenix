/**
 * Text in a draft that would not show as it is sent, found so signing can refuse it
 * (`verifyDisplayedVersion`) and the preview can mark it (`markHiddenText`). Why, and why a To
 * address is held to plain ASCII: docs/internals/sales-approvals.md.
 */

export type DraftField = "to" | "subject" | "body";

export interface HiddenTextFinding {
  readonly field: DraftField;
  readonly kind: "character" | "blank-lines" | "spaces" | "marks";
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
/** Up to this many combining marks on one letter read as text; more stack over other lines. */
const MAX_MARKS = 4;

/**
 * What renders as nothing or is not text: default-ignorable code points (zero-width and format
 * characters, variation selectors, Hangul fillers), Unicode's "Other" characters (control,
 * surrogate, private use, unassigned) and the line and paragraph separators.
 */
const NOT_SHOWN = "\\p{Default_Ignorable_Code_Point}\\p{C}\\p{Zl}\\p{Zp}";
/** A symbol, not a space, that draws as blank. */
const BRAILLE_BLANK = "\\u2800";
const INVISIBLE = `[${NOT_SHOWN}${BRAILLE_BLANK}]`;
/** A zero-width joiner between two emoji is what makes them one (👩‍💻). */
const EMOJI_JOINER =
  "(?<=\\p{Extended_Pictographic}[\\uFE0F\\u{1F3FB}-\\u{1F3FF}]?)\\u200D(?=\\p{Extended_Pictographic})";
/** One text or emoji presentation selector on a visible character picks how it is drawn (❤️, 1️⃣). */
const PRESENTATION_SELECTOR = `(?<=[^\\s${NOT_SHOWN}${BRAILLE_BLANK}])[\\uFE0E\\uFE0F]`;
const HIDDEN_CHARACTER = `(?!${EMOJI_JOINER}|${PRESENTATION_SELECTOR})${INVISIBLE}`;
/** Spaces and tabs; anything else blank is a hidden character. */
const BLANK = "[\\p{Zs}\\t]";
const SPACES = `${BLANK}{${MAX_SPACES + 1},}`;
/** Combining marks that draw: the ignorable ones (variation selectors) are hidden characters. */
const MARKS = `[^\\P{M}\\p{Default_Ignorable_Code_Point}]{${MAX_MARKS + 1},}`;

const PATTERNS: Record<DraftField, RegExp> = {
  // Anything outside printable ASCII, so a look-alike letter cannot pass for the address.
  to: /[^\x20-\x7E]/gu,
  subject: new RegExp(`(?<spaces>${SPACES})|(?<marks>${MARKS})|${HIDDEN_CHARACTER}`, "gu"),
  // A body keeps its line breaks and tabs, and a CR only as part of a CRLF line ending.
  body: new RegExp(
    `(?<=^|\\n)(?<lines>(?:${BLANK}*\\r?\\n){${MAX_BLANK_LINES + 1},})|(?<spaces>${SPACES})|` +
      `(?<marks>${MARKS})|(?![\\n\\t]|\\r\\n)${HIDDEN_CHARACTER}`,
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
    const { lines, spaces, marks } = match.groups ?? {};
    if (lines !== undefined) {
      const count = lines.split("\n").length - 1;
      return { field, kind: "blank-lines", start, end, token: `⟨${count} blank lines⟩\n` };
    }
    if (spaces !== undefined) {
      return { field, kind: "spaces", start, end, token: `⟨${spaces.length} spaces⟩` };
    }
    if (marks !== undefined) {
      const count = Array.from(marks).length;
      return { field, kind: "marks", start, end, token: `⟨${count} combining marks⟩` };
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
 * A subject or body without what nobody can find to delete by hand, for an edit the person asks
 * for. Hidden characters go, but a line break becomes a plain one in a body, and a line break
 * (CRLF included) or tab becomes one space in a subject. A subject's run of spaces becomes one
 * space too, since a one-line field scrolls it out of view. Blank lines, a body's spaces and stacked marks stay: an edit shows them.
 */
export function withoutHiddenCharacters(field: "subject" | "body", text: string): string {
  let out = "";
  let at = 0;
  for (const finding of findingsIn(field, text)) {
    const replacement = replacementFor(field, text, finding);
    if (replacement === null) continue;
    out += text.slice(at, finding.start) + replacement;
    at = finding.end;
  }
  return out + text.slice(at);
}

/** What `withoutHiddenCharacters` puts in a finding's place, or null to keep it. */
function replacementFor(
  field: "subject" | "body",
  text: string,
  { kind, start, end }: HiddenTextFinding,
): string | null {
  if (kind === "spaces") return field === "subject" ? " " : null;
  if (kind !== "character") return null;
  const char = text.slice(start, end);
  // The LF of a CRLF stands for both.
  if (char === "\r" && text[end] === "\n") return "";
  if (field === "body") return LINE_BREAK.test(char) ? "\n" : "";
  return LINE_BREAK.test(char) || char === "\t" ? " " : "";
}
