import { PostReportInput, ReadSessionInput } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const decodeReadSessionInput = Schema.decodeUnknownEffect(ReadSessionInput);
const decodePostReportInput = Schema.decodeUnknownEffect(PostReportInput);

it.effect("read_session accepts messageLimit at the bounds (0 and 20)", () =>
  Effect.gen(function* () {
    const atMax = yield* decodeReadSessionInput({ threadId: "thread-1", messageLimit: 20 });
    assert.equal(atMax.messageLimit, 20);

    const atMin = yield* decodeReadSessionInput({ threadId: "thread-1", messageLimit: 0 });
    assert.equal(atMin.messageLimit, 0);
  }),
);

it.effect("read_session rejects messageLimit above 20", () =>
  decodeReadSessionInput({ threadId: "thread-1", messageLimit: 21 }).pipe(Effect.flip),
);

it.effect("post_report accepts optional structured fields", () =>
  Effect.gen(function* () {
    const input = yield* decodePostReportInput({
      status: "partial",
      title: "Partial progress",
      summary: "Some tasks done.",
      findings: [{ title: "Flaky test", severity: "low" }],
      validation: { performed: ["Ran unit tests"], gaps: [] },
      recommendation: "Investigate flake before merging.",
      completionPercent: 50,
    });
    assert.equal(input.completionPercent, 50);
    assert.deepStrictEqual(input.findings, [{ title: "Flaky test", severity: "low" }]);
  }),
);

it.effect("post_report decodes fine without any structured fields", () =>
  Effect.gen(function* () {
    const input = yield* decodePostReportInput({
      status: "success",
      title: "Done",
      summary: "All done.",
    });
    assert.isUndefined(input.findings);
    assert.isUndefined(input.completionPercent);
  }),
);

it.effect("post_report rejects completionPercent above 100", () =>
  decodePostReportInput({
    status: "success",
    title: "Done",
    summary: "All done.",
    completionPercent: 101,
  }).pipe(Effect.flip),
);
