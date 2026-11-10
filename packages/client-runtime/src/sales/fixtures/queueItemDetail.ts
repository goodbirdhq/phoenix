import type { SalesQueueItemDetail } from "@t3tools/contracts";

import { SALES_HASH_ALGORITHM } from "../approval.ts";
import vectors from "./sales-api-vectors.json" with { type: "json" };

// A threaded chase from the engine's conformance vectors (see conformance.test.ts).
const chaseVector = vectors.contentHash.find(
  (vector) => vector.name === "threaded chase, answers null",
)!;
export const hashInput = chaseVector.input;
export const ENGINE_HASH = chaseVector.expected;

/** A waiting chase whose hash inputs verify against `contentHash`. */
export const detail = (overrides: Partial<SalesQueueItemDetail> = {}): SalesQueueItemDetail => ({
  activityId: "act-1",
  kind: "chase",
  step: 2,
  stepLabel: "Email 2",
  contact: {
    id: "c1",
    name: "Ana",
    email: "ana@brand.example",
    accountName: "Brand",
    timeZone: null,
    effectiveTimeZone: "America/Los_Angeles",
    notionUrl: "https://www.notion.so/c1",
    linkedinUrl: null,
  },
  campaign: null,
  subject: "Re: creator x fintech",
  threaded: true,
  bodyPreview: "Hey Ana, Thanks for the note",
  contentHash: ENGINE_HASH,
  state: "awaiting",
  approval: null,
  sendAt: null,
  goes: null,
  mailbox: { sticky: true, address: "gabe@trygoodbird.com", threadState: "open" },
  refusal: null,
  note: null,
  check: null,
  skip: null,
  sendStatus: null,
  notionUrl: "https://www.notion.so/act1",
  rowEditedAt: null,
  body: hashInput.body,
  rowName: hashInput.rowName,
  hashInput,
  hashAlgorithm: SALES_HASH_ALGORITHM,
  ...overrides,
});
