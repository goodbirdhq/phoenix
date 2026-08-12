import { SessionReportStructured } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const decodeSessionReportStructured = Schema.decodeUnknownSync(SessionReportStructured);

/**
 * Decodes the `structured_json` report column leniently: a malformed or
 * schema-violating blob is logged and treated as absent rather than failing
 * the whole row, so a bad structured payload can never block report access
 * (read_session, thread detail hydration, …).
 */
export function decodeStructuredReportFields(
  json: string | null,
): SessionReportStructured | undefined {
  if (json === null) {
    return undefined;
  }
  try {
    return decodeSessionReportStructured(JSON.parse(json));
  } catch (cause) {
    Effect.runFork(
      Effect.logWarning("Failed to decode structured report fields; treating them as absent.").pipe(
        Effect.annotateLogs({ cause: cause instanceof Error ? cause.message : String(cause) }),
      ),
    );
    return undefined;
  }
}
