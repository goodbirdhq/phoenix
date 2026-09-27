import * as Effect from "effect/Effect";

import { HostProcessArguments } from "@t3tools/shared/hostProcess";

import packageJson from "../../package.json" with { type: "json" };

/**
 * Render a command for the installed or source-built Phoenix binary. The npm
 * package is scoped (@goodbirdhq/phoenix) while the binary is `phoenix`, so a
 * package-runner suggestion like `npx phoenix` would execute an unrelated
 * package and must never be emitted.
 */
export function formatCliCommand(input: {
  readonly subcommand: string;
  readonly entryPath: string;
  readonly version: string;
}): string {
  return `phoenix ${input.subcommand}`;
}

/** `formatCliCommand` against this process's real entry path and version. */
export const resolveCliCommand = (subcommand: string) =>
  Effect.map(HostProcessArguments, (processArguments) =>
    formatCliCommand({
      subcommand,
      entryPath: processArguments[1] ?? "",
      version: packageJson.version,
    }),
  );
