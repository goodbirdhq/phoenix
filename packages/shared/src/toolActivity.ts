import type { ToolLifecycleItemType } from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
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

function spawnedSessionResult(value: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(value) ?? parseJsonRecord(value);
  if (!direct) {
    return undefined;
  }
  if (asTrimmedString(direct.threadId)) {
    return direct;
  }

  for (const key of ["structuredContent", "structured_content"]) {
    const structured = asRecord(direct[key]) ?? parseJsonRecord(direct[key]);
    if (structured && asTrimmedString(structured.threadId)) {
      return structured;
    }
  }

  const content = direct.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const parsed = parseJsonRecord(asRecord(block)?.text);
      if (parsed && asTrimmedString(parsed.threadId)) {
        return parsed;
      }
    }
    return undefined;
  }
  const parsedContent = parseJsonRecord(content);
  return parsedContent && asTrimmedString(parsedContent.threadId) ? parsedContent : undefined;
}

function isPhoenixSpawnSessionTool(data: Record<string, unknown>, item: Record<string, unknown>) {
  const server = asTrimmedString(item.server)?.toLowerCase();
  const itemTool = asTrimmedString(item.tool)?.toLowerCase();
  const name = asTrimmedString(data.toolName)?.toLowerCase();
  return (
    (server === "phoenix" && itemTool === "spawn_session") || name === "mcp__phoenix__spawn_session"
  );
}

export interface SpawnedSessionToolActivity {
  readonly title: string;
  readonly threadId?: string | undefined;
  readonly model?: string | undefined;
}

/**
 * Recognizes Phoenix's session-spawn MCP call across provider payload shapes.
 * The child thread id only appears after the tool result lands, while the
 * requested title is available during the in-progress lifecycle update.
 *
 * Reads `data.spawnedSession` first: the server slims MCP results down to a
 * one-line preview before they reach a client, which would otherwise cut the
 * thread id out of the spawn result, so it carries the derived identity in
 * that field. Raw provider payloads (server-side, and pre-slimming clients)
 * still resolve from `result`/`arguments` below.
 */
export function deriveSpawnedSessionToolActivity(
  value: unknown,
): SpawnedSessionToolActivity | undefined {
  const data = asRecord(value);
  if (!data) {
    return undefined;
  }
  const item = asRecord(data.item);
  if (!isPhoenixSpawnSessionTool(data, item ?? {})) {
    return undefined;
  }

  const input = asRecord(item?.arguments) ?? asRecord(item?.input) ?? asRecord(data.input);
  const projected = asRecord(data.spawnedSession);
  const result = spawnedSessionResult(item?.result ?? data.result);
  const modelSelection = asRecord(result?.modelSelection);
  const title =
    asTrimmedString(projected?.title) ??
    asTrimmedString(result?.title) ??
    asTrimmedString(input?.title);
  const threadId = asTrimmedString(projected?.threadId) ?? asTrimmedString(result?.threadId);
  const model =
    asTrimmedString(projected?.model) ??
    asTrimmedString(modelSelection?.model) ??
    asTrimmedString(input?.model);

  return {
    title: title ?? "New agent session",
    ...(threadId ? { threadId } : {}),
    ...(model ? { model } : {}),
  };
}

function normalizeCommandValue(value: unknown): string | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const entry of value) {
    const part = asTrimmedString(entry);
    if (part !== undefined) {
      parts.push(part);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function stripTrailingExitCode(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code \d+>)\s*$/iu.exec(trimmed);
  const output = match?.groups?.output?.trim() ?? trimmed;
  return output.length > 0 ? output : undefined;
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  const backtickMatch = /`([^`]+)`/u.exec(title);
  return backtickMatch?.[1]?.trim() || undefined;
}

function extractToolCommand(data: Record<string, unknown> | undefined, title: string | undefined) {
  const item = asRecord(data?.item);
  const itemInput = asRecord(item?.input);
  const itemResult = asRecord(item?.result);
  const rawInput = asRecord(data?.rawInput);
  const candidates = [
    normalizeCommandValue(item?.command),
    normalizeCommandValue(itemInput?.command),
    normalizeCommandValue(itemResult?.command),
    normalizeCommandValue(data?.command),
    normalizeCommandValue(rawInput?.command),
  ];
  const direct = candidates.find((candidate) => candidate !== undefined);
  if (direct) {
    return direct;
  }
  const executable = asTrimmedString(rawInput?.executable);
  const args = normalizeCommandValue(rawInput?.args);
  if (executable && args) {
    return `${executable} ${args}`;
  }
  if (executable) {
    return executable;
  }
  return extractCommandFromTitle(title);
}

function maybePathLike(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.startsWith(".") ||
    /\.(?:[a-z0-9]{1,12})$/iu.test(value)
  ) {
    return value;
  }
  return undefined;
}

function collectPaths(value: unknown, paths: string[], seen: Set<string>, depth: number): void {
  if (depth > 4 || paths.length >= 8) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectPaths(entry, paths, seen, depth + 1);
      if (paths.length >= 8) {
        return;
      }
    }
    return;
  }
  const record = asRecord(value);
  if (!record) {
    return;
  }
  for (const key of ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"]) {
    const candidate = maybePathLike(asTrimmedString(record[key]));
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    paths.push(candidate);
    if (paths.length >= 8) {
      return;
    }
  }
  for (const nestedKey of ["locations", "item", "input", "result", "rawInput", "data", "changes"]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectPaths(record[nestedKey], paths, seen, depth + 1);
    if (paths.length >= 8) {
      return;
    }
  }
}

function extractPrimaryPath(data: Record<string, unknown> | undefined): string | undefined {
  const paths: string[] = [];
  collectPaths(data, paths, new Set<string>(), 0);
  return paths[0];
}

function normalizeEquivalentValue(value: string | undefined): string | undefined {
  const trimmed = asTrimmedString(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/\s+/gu, " ")
    .replace(/\s+(?:complete|completed|started)\s*$/iu, "")
    .trim();
}

function isEquivalent(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeEquivalentValue(left)?.toLowerCase();
  const normalizedRight = normalizeEquivalentValue(right)?.toLowerCase();
  return normalizedLeft !== undefined && normalizedLeft === normalizedRight;
}

function classifyToolAction(input: {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
}): "command" | "read" | "file_change" | "search" | "other" {
  const itemType = input.itemType ?? undefined;
  const kind = asTrimmedString(input.data?.kind)?.toLowerCase();
  const title = asTrimmedString(input.title)?.toLowerCase();
  if (itemType === "command_execution" || kind === "execute" || title === "terminal") {
    return "command";
  }
  if (kind === "read" || title === "read file") {
    return "read";
  }
  if (
    itemType === "file_change" ||
    kind === "edit" ||
    kind === "move" ||
    kind === "delete" ||
    kind === "write"
  ) {
    return "file_change";
  }
  if (itemType === "web_search" || kind === "search" || title === "find" || title === "grep") {
    return "search";
  }
  return "other";
}

export interface ToolActivityPresentationInput {
  readonly itemType?: ToolLifecycleItemType | null | undefined;
  readonly title?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly data?: unknown;
  readonly fallbackSummary?: string | null | undefined;
}

export interface ToolActivityPresentation {
  readonly summary: string;
  readonly detail?: string | undefined;
}

export function deriveToolActivityPresentation(
  input: ToolActivityPresentationInput,
): ToolActivityPresentation {
  const title = asTrimmedString(input.title);
  const detail = stripTrailingExitCode(asTrimmedString(input.detail));
  const fallbackSummary = asTrimmedString(input.fallbackSummary) ?? "Tool";
  const data = asRecord(input.data);
  const command = extractToolCommand(data, title);
  const primaryPath = extractPrimaryPath(data);
  const action = classifyToolAction({
    itemType: input.itemType,
    title,
    data,
  });

  if (action === "command") {
    return {
      summary: "Ran command",
      ...(command ? { detail: command } : {}),
    };
  }

  if (action === "read") {
    if (primaryPath) {
      return {
        summary: "Read file",
        detail: primaryPath,
      };
    }
    return {
      summary: "Read file",
    };
  }

  if (action === "file_change") {
    return {
      summary: "Changed files",
      ...(primaryPath ? { detail: primaryPath } : {}),
    };
  }

  if (action === "search") {
    const query =
      asTrimmedString(asRecord(data?.rawInput)?.query) ??
      asTrimmedString(asRecord(data?.rawInput)?.pattern) ??
      asTrimmedString(asRecord(data?.rawInput)?.searchTerm);
    return {
      summary: "Searched files",
      ...(query ? { detail: query } : {}),
    };
  }

  if (detail && !isEquivalent(detail, title) && !isEquivalent(detail, fallbackSummary)) {
    return {
      summary: title ?? fallbackSummary,
      detail,
    };
  }

  return {
    summary: title ?? fallbackSummary,
  };
}
