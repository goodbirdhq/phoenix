import { assert, it } from "@effect/vitest";

import { decodeStructuredReportFields } from "./decodeStructuredReportFields.ts";

it("returns undefined for a null column", () => {
  assert.isUndefined(decodeStructuredReportFields(null));
});

it("decodes a valid structured payload", () => {
  const decoded = decodeStructuredReportFields(
    JSON.stringify({
      findings: [{ title: "Missing test", severity: "medium" }],
      completionPercent: 80,
    }),
  );
  assert.deepStrictEqual(decoded, {
    findings: [{ title: "Missing test", severity: "medium" }],
    completionPercent: 80,
  });
});

it("degrades to undefined instead of throwing on malformed JSON", () => {
  assert.isUndefined(decodeStructuredReportFields("{not valid json"));
});

it("degrades to undefined instead of throwing on schema-violating JSON", () => {
  assert.isUndefined(decodeStructuredReportFields(JSON.stringify({ completionPercent: 999 })));
});
