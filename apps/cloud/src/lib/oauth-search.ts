import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";

export function parseCloudSearch(search: string) {
  const params = new URLSearchParams(search);
  if (!params.has("sig") || !params.has("ba_param")) return defaultParseSearch(search);
  // Better Auth signs repeated ba_param fields and string values; JSON coercion breaks its signature.
  const result: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    result[key] = values.length === 1 ? values[0]! : values;
  }
  return result;
}

export function stringifyCloudSearch(search: Record<string, unknown>) {
  if (typeof search.sig !== "string" || !search.ba_param) return defaultStringifySearch(search);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === "string") params.append(key, value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") params.append(key, item);
    }
  }
  return params.size ? `?${params}` : "";
}

export const deviceSearch = (search: Record<string, unknown>): { user_code?: string } =>
  typeof search.client_id === "string"
    ? {}
    : { user_code: typeof search.user_code === "string" ? search.user_code : "" };
