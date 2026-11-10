import { describe, expect, it } from "vite-plus/test";

import {
  findingPlace,
  hiddenTextFindings,
  markHiddenText,
  withoutHiddenCharacters,
} from "./hiddenText.ts";
import { hashInput } from "./fixtures/queueItemDetail.ts";
import { computeContentHash } from "./signing.ts";
import vectors from "./fixtures/sales-api-vectors.json" with { type: "json" };

const draft = (patch: { to?: string; subject?: string; body?: string }) => ({
  to: "ana@brand.example",
  subject: "creator x fintech",
  body: "Hey Ana,\n\nQuick one.\n\nGabriel",
  ...patch,
});

const tokens = (patch: Parameters<typeof draft>[0]) =>
  hiddenTextFindings(draft(patch)).map(({ field, kind, token }) => ({ field, kind, token }));

describe("hiddenTextFindings", () => {
  it("passes ordinary email text: accents, emoji, tabs, CRLF and a few blank lines", () => {
    expect(
      tokens({
        subject: "Café ☕ – “quotes” ❤️",
        body: "Olá Zoë, Việt ạ 👩\u200D💻 👍🏽 🏳️\u200D🌈 1️⃣ #️⃣ ☺︎\r\nTab:\there.\n\n\n\nThree blank lines above.\n",
      }),
    ).toEqual([]);
    for (const { input } of vectors.contentHash) {
      // Every conformance body and subject is something a person can read in full.
      expect(tokens({ subject: input.subject, body: input.body })).toEqual([]);
    }
  });

  it("finds invisible and format characters, and bidi controls that reorder what is shown", () => {
    expect(
      tokens({ body: "Pay\u200B to\u2060 \u00AD\uFEFF\u202Eexample\u202C \u2067x\u2069\u200F" }),
    ).toEqual(
      [
        "U+200B",
        "U+2060",
        "U+00AD",
        "U+FEFF",
        "U+202E",
        "U+202C",
        "U+2067",
        "U+2069",
        "U+200F",
      ].map((point) => ({ field: "body", kind: "character", token: `⟨${point}⟩` })),
    );
    // Tag characters can spell out a whole hidden message; a joiner outside an emoji joins nothing.
    expect(tokens({ subject: "hi\u{E0041}", body: "a\u200Db" })).toEqual([
      { field: "subject", kind: "character", token: "⟨U+E0041⟩" },
      { field: "body", kind: "character", token: "⟨U+200D⟩" },
    ]);
  });

  it("finds variation selectors past one per visible character, so they carry no message", () => {
    // Each selector can stand for a byte: "hi" followed by a payload a reader never sees.
    expect(tokens({ subject: "hi\u{E0100}\u{E0161}" }).map(({ token }) => token)).toEqual([
      "⟨U+E0100⟩",
      "⟨U+E0161⟩",
    ]);
    expect(
      tokens({ body: "❤️\uFE0F x\uFE00 \uFE0F y\u034F\u180B\u17B4" }).map(({ token }) => token),
    ).toEqual(["⟨U+FE0F⟩", "⟨U+FE00⟩", "⟨U+FE0F⟩", "⟨U+034F⟩", "⟨U+180B⟩", "⟨U+17B4⟩"]);
  });

  it("finds marks stacked on one letter past what any language writes", () => {
    expect(tokens({ body: "Hey Ana, z\u0301\u0302\u0303\u0304\u0305 here" })).toEqual([
      { field: "body", kind: "marks", token: "⟨5 combining marks⟩" },
    ]);
  });

  it("finds control characters, keeping a body's line breaks, tabs and CRLF endings", () => {
    expect(tokens({ body: "a\x07b\rc\u2028d\x85" }).map(({ token }) => token)).toEqual([
      "⟨U+0007⟩",
      "⟨U+000D⟩",
      "⟨U+2028⟩",
      "⟨U+0085⟩",
    ]);
    // A subject is one line: a line break or a tab there is hidden by a one-line field.
    expect(tokens({ subject: "Re: creator\nx\tfintech" }).map(({ token }) => token)).toEqual([
      "⟨U+000A⟩",
      "⟨U+0009⟩",
    ]);
  });

  it("finds a wall of blank lines or spaces that pushes text out of view", () => {
    const body = `Hey Ana,\n\n\n\n \n\t\nP.S. wire it.${" ".repeat(16)}\n`;
    expect(tokens({ body })).toEqual([
      { field: "body", kind: "blank-lines", token: "⟨5 blank lines⟩\n" },
      { field: "body", kind: "spaces", token: "⟨16 spaces⟩" },
    ]);
    expect(tokens({ body: "\n\n\n\nHi" })).toMatchObject([{ token: "⟨4 blank lines⟩\n" }]);
    expect(tokens({ body: `a${" ".repeat(15)}b\n\n\n\nc` })).toEqual([]);
  });

  it("finds a wall hidden behind invisible characters, and the wall once they are removed", () => {
    // Lines of only an ignorable character, and a run of spaces split by one, still hide text.
    const lines = `Hey Ana,\n${"\u034F\n".repeat(4)}P.S. wire it.`;
    const spaces = `Hey Ana,${" ".repeat(8)}\u034F${" ".repeat(8)}P.S. wire it.`;
    expect(tokens({ body: lines })).toHaveLength(4);
    expect(tokens({ body: spaces })).toEqual([
      { field: "body", kind: "character", token: "⟨U+034F⟩" },
    ]);
    expect(tokens({ body: withoutHiddenCharacters("body", lines) })).toEqual([
      { field: "body", kind: "blank-lines", token: "⟨4 blank lines⟩\n" },
    ]);
    expect(tokens({ body: withoutHiddenCharacters("body", spaces) })).toEqual([
      { field: "body", kind: "spaces", token: "⟨16 spaces⟩" },
    ]);
  });

  it("scans the subject and To address as the hash keeps them, trimmed", async () => {
    const hash = (patch: Partial<typeof hashInput>) =>
      computeContentHash({ ...hashInput, ...patch });
    for (const pad of [" ", "\t", "\n", "\uFEFF", "\u2028", "\u00A0", "\u200B", "\u034F"]) {
      const subject = `${pad}Hi${pad}`;
      const trimmedByHash = (await hash({ subject })) === (await hash({ subject: "Hi" }));
      expect(tokens({ subject }).length === 0).toBe(trimmedByHash);
      const to = `${pad}ana@brand.example${pad}`;
      const toTrimmedByHash =
        (await hash({ toAddress: to })) === (await hash({ toAddress: "ana@brand.example" }));
      expect(tokens({ to }).length === 0).toBe(toTrimmedByHash);
    }
  });

  it("holds the To address to printable ASCII, so a look-alike letter shows", () => {
    expect(tokens({ to: "аna@brand.example" })).toEqual([
      { field: "to", kind: "character", token: "⟨U+0430⟩" },
    ]);
    expect(tokens({ to: "zoë@café.example" })).toHaveLength(2);
    expect(tokens({ to: "ana\u200B@brand.example" })).toHaveLength(1);
    expect(tokens({ to: "  Emily.Chen@Firm.COM " })).toEqual([]);
  });
});

describe("markHiddenText", () => {
  it("cuts a field at its findings without changing a character of it", () => {
    const body = "Hey\u200B Ana,\n\n\n\n\nWire it.";
    const findings = hiddenTextFindings(draft({ body })).filter((f) => f.field === "body");
    const segments = markHiddenText(body, findings);
    expect(segments.map(({ text }) => text).join("")).toBe(body);
    expect(segments.map(({ text, token }) => token ?? text).join("")).toBe(
      "Hey⟨U+200B⟩ Ana,\n⟨4 blank lines⟩\nWire it.",
    );
    expect(findings.map((finding) => findingPlace(body, finding))).toEqual([
      "line 1 of the body",
      "line 2 of the body",
    ]);
  });

  it("shows a clean field as itself", () => {
    expect(markHiddenText("Hi", [])).toEqual([{ text: "Hi", token: null }]);
    expect(markHiddenText("", [])).toEqual([{ text: "", token: null }]);
  });
});

describe("withoutHiddenCharacters", () => {
  it("takes out what nobody can delete by hand and keeps everything a person can see", () => {
    expect(
      withoutHiddenCharacters("body", "Hi\u200B Ana,\r\nok\rnext 👩\u200D💻\u202E\n\n\n\n\nx"),
    ).toBe("Hi Ana,\r\nok\nnext 👩\u200D💻\n\n\n\n\nx");
    expect(withoutHiddenCharacters("subject", "Re: creator\nx\u00ADfintech")).toBe(
      "Re: creator xfintech",
    );
  });

  it("puts a subject on one line: a CRLF or a run of spaces becomes one space", () => {
    expect(withoutHiddenCharacters("subject", `Re: creator\r\nx${" ".repeat(20)}fintech`)).toBe(
      "Re: creator x fintech",
    );
  });
});
