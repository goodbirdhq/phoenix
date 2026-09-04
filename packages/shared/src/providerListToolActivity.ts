import { asRecord, asTrimmedString, parseJsonRecord } from "./toolActivityPayload.ts";

function isPhoenixProviderListTool(
  data: Record<string, unknown>,
  item: Record<string, unknown>,
): boolean {
  const server = asTrimmedString(item.server)?.toLowerCase();
  const itemTool = asTrimmedString(item.tool)?.toLowerCase();
  if (server === "phoenix" && itemTool === "list_session_providers") return true;
  const flattened = asTrimmedString(data.toolName)?.toLowerCase();
  return flattened === "mcp__phoenix__list_session_providers";
}

export interface ProviderListEntry {
  readonly instanceId: string;
  readonly displayName: string;
  readonly driver: string;
  readonly available: boolean;
  readonly status: "available" | "limited" | "unknown";
  readonly windows: ReadonlyArray<{
    readonly kind: string;
    readonly usedPercent: number;
  }>;
}

export interface ProviderListToolActivity {
  readonly providers: ReadonlyArray<ProviderListEntry>;
}

function asStatus(value: unknown): ProviderListEntry["status"] | undefined {
  return value === "available" || value === "limited" || value === "unknown" ? value : undefined;
}

function deriveEntry(raw: unknown): ProviderListEntry | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const instanceId = asTrimmedString(record.instanceId);
  if (!instanceId) return undefined;
  const displayName = asTrimmedString(record.displayName) ?? instanceId;
  const driver = asTrimmedString(record.driver) ?? "unknown";
  const available = typeof record.available === "boolean" ? record.available : false;
  // Projected carrier stores flattened status/windows; raw MCP result nests them under availability.
  const availability = asRecord(record.availability);
  const status = asStatus(availability?.status) ?? asStatus(record.status) ?? "unknown";
  const rawWindowsSource = Array.isArray(availability?.windows)
    ? (availability?.windows as unknown[])
    : Array.isArray(record.windows)
      ? (record.windows as unknown[])
      : [];
  const windows: Array<{ kind: string; usedPercent: number }> = [];
  for (const w of rawWindowsSource) {
    const wr = asRecord(w);
    if (!wr) continue;
    const kind = asTrimmedString(wr.kind);
    const usedPercent = typeof wr.usedPercent === "number" ? wr.usedPercent : undefined;
    if (!kind || usedPercent === undefined) continue;
    if (usedPercent < 0 || usedPercent > 100 || !Number.isFinite(usedPercent)) continue;
    windows.push({ kind, usedPercent });
    if (windows.length >= 4) break;
  }
  return {
    instanceId,
    displayName,
    driver,
    available,
    status,
    windows,
  };
}

function findProvidersRecord(value: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(value) ?? parseJsonRecord(value);
  if (direct && Array.isArray(direct.providers)) return direct;

  if (direct) {
    for (const key of ["structuredContent", "structured_content"]) {
      const structured = asRecord(direct[key]) ?? parseJsonRecord(direct[key]);
      if (structured && Array.isArray(structured.providers)) return structured;
    }
    const content = direct.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const parsed = parseJsonRecord(asRecord(block)?.text);
        if (parsed && Array.isArray(parsed.providers)) return parsed;
      }
    }
    const parsedContent = parseJsonRecord(content);
    if (parsedContent && Array.isArray(parsedContent.providers)) return parsedContent;
  }
  return undefined;
}

/**
 * Recognizes Phoenix's list_session_providers MCP call and reduces it to the
 * handful of fields a chat card renders.
 *
 * Reads `data.providerListActivity` first: the server slims MCP results down to an
 * 84-character preview before they reach a client, which would cut the provider
 * list out entirely, so it carries this derived form explicitly in that field.
 * Raw provider payloads (server-side, and pre-slimming clients) still resolve
 * from `result` below.
 */
export function deriveProviderListToolActivity(
  value: unknown,
): ProviderListToolActivity | undefined {
  const data = asRecord(value);
  if (!data) return undefined;
  const item = asRecord(data.item);
  if (!isPhoenixProviderListTool(data, item ?? {})) return undefined;

  const projected = asRecord(data.providerListActivity);
  if (projected !== undefined) {
    const rawProviders = Array.isArray(projected.providers)
      ? (projected.providers as unknown[])
      : undefined;
    if (rawProviders && rawProviders.length > 0) {
      const providers: ProviderListEntry[] = [];
      for (const raw of rawProviders) {
        const entry = deriveEntry(raw);
        if (entry) providers.push(entry);
        if (providers.length >= 8) break;
      }
      if (providers.length > 0) return { providers };
    }
    // Projected carrier present but empty/invalid -> treat as no card (failed/in-progress).
    if (rawProviders !== undefined) return undefined;
  }

  const resultRecord = findProvidersRecord(item?.result ?? data.result);
  if (!resultRecord) return undefined;
  const rawProviders = resultRecord.providers as unknown[];
  const providers: ProviderListEntry[] = [];
  for (const raw of rawProviders) {
    const entry = deriveEntry(raw);
    if (entry) providers.push(entry);
    if (providers.length >= 8) break;
  }
  if (providers.length === 0) return undefined;
  return { providers };
}
