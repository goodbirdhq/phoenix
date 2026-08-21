/**
 * Argument parsing for the `ops` CLI. Lives here rather than in cli.ts so it
 * can be tested without importing that module, which runs `main()` on import.
 */

/**
 * Value of `--flag value` or `--flag=value`, or undefined if absent. A
 * trailing `--flag` with nothing after it, and a `--flag --other` pair, both
 * read as absent rather than swallowing the next flag as a value.
 */
export function readFlag(args: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
    if (arg === flag) {
      const value = args[i + 1];
      return value === undefined || value.startsWith("--") ? undefined : value;
    }
  }
  return undefined;
}

/** Positional args only — everything but a known flag and its value. */
export function positionalArgs(args: readonly string[], flags: readonly string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (flags.some((flag) => arg.startsWith(`${flag}=`))) continue;
    if (flags.includes(arg)) {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("--")) i += 1; // skip its value
      continue;
    }
    positional.push(arg);
  }
  return positional;
}
