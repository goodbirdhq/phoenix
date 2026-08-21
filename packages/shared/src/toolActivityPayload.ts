/**
 * Shape-digging helpers shared by the tool-activity derivers.
 *
 * Provider payloads for the same tool call arrive in several shapes — a record,
 * a JSON string, a `{content: [{text}]}` block list — and every deriver has to
 * walk them the same way before it can read a field.
 */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  const text = asTrimmedString(value);
  if (!text) {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Finds the record carrying `identityKey` in whichever shape a provider used.
 * The key doubles as the "this call succeeded" signal: a failed tool result has
 * no identity to find, so callers fall through to their generic rendering.
 */
export function findResultRecord(
  value: unknown,
  identityKey: string,
): Record<string, unknown> | undefined {
  const direct = asRecord(value) ?? parseJsonRecord(value);
  if (!direct) {
    return undefined;
  }
  if (asTrimmedString(direct[identityKey])) {
    return direct;
  }

  for (const key of ["structuredContent", "structured_content"]) {
    const structured = asRecord(direct[key]) ?? parseJsonRecord(direct[key]);
    if (structured && asTrimmedString(structured[identityKey])) {
      return structured;
    }
  }

  const content = direct.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const parsed = parseJsonRecord(asRecord(block)?.text);
      if (parsed && asTrimmedString(parsed[identityKey])) {
        return parsed;
      }
    }
  }

  // A raw Claude `tool_result` whose content is the JSON string itself.
  const parsedContent = parseJsonRecord(content);
  return parsedContent && asTrimmedString(parsedContent[identityKey]) ? parsedContent : undefined;
}
