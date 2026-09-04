import { asRecord, asTrimmedString, parseJsonRecord } from "./toolActivityPayload.ts";

export const PROVIDER_LIST_MAX_PROVIDERS = 8;
export const PROVIDER_LIST_MAX_WINDOWS = 4;

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

export interface ProviderListWindow {
  readonly kind: string;
  readonly label?: string;
  readonly usedPercent: number;
}

export interface ProviderListEntry {
  readonly instanceId: string;
  readonly displayName: string;
  readonly driver: string;
  /** Whether this instance can currently start a session. */
  readonly available: boolean;
  /** Quota telemetry for this instance — independent of spawnability. */
  readonly status: "available" | "limited" | "unknown";
  readonly windows: ReadonlyArray<ProviderListWindow>;
}

export interface ProviderListToolActivity {
  readonly providers: ReadonlyArray<ProviderListEntry>;
  /** Count of providers in the tool result, before the card cap. */
  readonly totalCount: number;
}

function asStatus(value: unknown): ProviderListEntry["status"] | undefined {
  return value === "available" || value === "limited" || value === "unknown" ? value : undefined;
}

function asFinitePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 100) return undefined;
  return value;
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
    ? (availability.windows as unknown[])
    : Array.isArray(record.windows)
      ? (record.windows as unknown[])
      : [];
  const windows: ProviderListWindow[] = [];
  for (const w of rawWindowsSource) {
    const wr = asRecord(w);
    if (!wr) continue;
    const kind = asTrimmedString(wr.kind);
    const usedPercent = asFinitePercent(wr.usedPercent);
    if (!kind || usedPercent === undefined) continue;
    const label = asTrimmedString(wr.label);
    windows.push(label ? { kind, label, usedPercent } : { kind, usedPercent });
    if (windows.length >= PROVIDER_LIST_MAX_WINDOWS) break;
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

function asTotalCount(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= fallback) {
    return Math.floor(value);
  }
  return fallback;
}

function collectActivity(
  rawProviders: unknown[],
  totalHint: unknown,
): ProviderListToolActivity | undefined {
  const providers: ProviderListEntry[] = [];
  for (const raw of rawProviders) {
    const entry = deriveEntry(raw);
    if (entry) providers.push(entry);
    if (providers.length >= PROVIDER_LIST_MAX_PROVIDERS) break;
  }
  if (providers.length === 0) return undefined;
  return {
    providers,
    totalCount: asTotalCount(totalHint, Math.max(providers.length, rawProviders.length)),
  };
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
    if (rawProviders !== undefined) {
      return collectActivity(rawProviders, projected.totalCount);
    }
  }

  const resultRecord = findProvidersRecord(item?.result ?? data.result);
  if (!resultRecord) return undefined;
  return collectActivity(
    resultRecord.providers as unknown[],
    (resultRecord.providers as unknown[]).length,
  );
}

function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value : Math.round(value)}%`;
}

export function formatProviderListWindows(windows: ReadonlyArray<ProviderListWindow>): string {
  return windows
    .map((window) => `${window.label ?? window.kind} ${formatPercent(window.usedPercent)}`)
    .join(" · ");
}

export function formatProviderListReadyLabel(available: boolean): "ready" | "offline" {
  return available ? "ready" : "offline";
}

export function formatProviderListQuotaLabel(
  status: ProviderListEntry["status"],
): "ok" | "limited" | "unknown" {
  if (status === "limited") return "limited";
  if (status === "available") return "ok";
  return "unknown";
}

/** Header summary tone: quota-limited wins over spawnable-ready. */
export function providerListSummaryTone(
  activity: ProviderListToolActivity,
): "success" | "warning" | "neutral" {
  if (activity.providers.some((provider) => provider.status === "limited")) return "warning";
  if (activity.providers.some((provider) => provider.available)) return "success";
  return "neutral";
}

export function formatProviderListHeading(activity: ProviderListToolActivity): string {
  const ready = activity.providers.filter((provider) => provider.available).length;
  const limited = activity.providers.filter((provider) => provider.status === "limited").length;
  const shown = activity.providers.length;
  const parts: string[] = [];
  if (activity.totalCount > shown) {
    parts.push(`showing ${shown} of ${activity.totalCount}`);
  }
  parts.push(ready === 1 ? "1 ready" : `${ready} ready`);
  if (limited > 0) {
    parts.push(limited === 1 ? "1 limited" : `${limited} limited`);
  }
  return `Providers · ${parts.join(" · ")}`;
}

export function formatProviderListPreview(activity: ProviderListToolActivity): string {
  const names = activity.providers.map((provider) => provider.displayName).join(", ");
  const ready = activity.providers.filter((provider) => provider.available).length;
  const shown = activity.providers.length;
  const count =
    activity.totalCount > shown ? `${ready} ready of ${shown} shown` : `${ready}/${shown} ready`;
  return names.length > 0 ? `${count} · ${names}` : count;
}
