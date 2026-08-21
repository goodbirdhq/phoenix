import {
  ProviderAvailability,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAvailability as ProviderAvailabilityValue,
  type ProviderDriverKind as ProviderDriverKindValue,
  type ProviderInstanceId as ProviderInstanceIdValue,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "../atomicWrite.ts";

const PersistedAvailabilityEntry = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  availability: ProviderAvailability,
  receivedAtMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
});

const PersistedAvailabilityDocument = Schema.Struct({
  entries: Schema.Array(Schema.Unknown),
});

const decodeDocument = Schema.decodeUnknownOption(
  Schema.fromJsonString(PersistedAvailabilityDocument),
);
const decodeEntry = Schema.decodeUnknownOption(PersistedAvailabilityEntry);

export interface DurableProviderAvailability {
  readonly driver: ProviderDriverKindValue;
  readonly availability: ProviderAvailabilityValue;
  readonly receivedAtMs: number;
}

export const readProviderAvailabilityCache = Effect.fn("readProviderAvailabilityCache")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
  if (raw.trim().length === 0) {
    return new Map<ProviderInstanceIdValue, DurableProviderAvailability>();
  }

  const document = decodeDocument(raw);
  if (Option.isNone(document)) {
    yield* Effect.logWarning("failed to parse provider availability cache, ignoring", {
      path: filePath,
    });
    return new Map<ProviderInstanceIdValue, DurableProviderAvailability>();
  }

  const entries = new Map<ProviderInstanceIdValue, DurableProviderAvailability>();
  for (const candidate of document.value.entries) {
    const decoded = decodeEntry(candidate);
    if (Option.isSome(decoded)) {
      const { instanceId, ...entry } = decoded.value;
      entries.set(instanceId, entry);
    }
  }
  return entries;
});

export const writeProviderAvailabilityCache = (input: {
  readonly filePath: string;
  readonly entries: ReadonlyMap<ProviderInstanceIdValue, DurableProviderAvailability>;
}) =>
  writeFileStringAtomically({
    filePath: input.filePath,
    contents: `${JSON.stringify(
      {
        version: 1,
        entries: [...input.entries].map(([instanceId, entry]) => ({ instanceId, ...entry })),
      },
      null,
      2,
    )}\n`,
  });
