import { EnvironmentId } from "@t3tools/contracts";

export const PHOENIX_CLOUD_CALLBACK_PATH = "/cloud/callback";
const ATTEMPT_KEY = "phoenix:cloud-browser-attempt:";

interface BrowserAttempt {
  readonly environmentId: EnvironmentId;
  readonly route: string;
}

interface BrowserCallback {
  readonly state: string;
  readonly code?: string;
  readonly error?: string;
  readonly iss: string;
  readonly returnUrl: string;
}

type AttemptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function safePhoenixCloudReturnRoute(value: string): string {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    Array.from(value).some((character) => character.charCodeAt(0) <= 32)
  )
    return "/";
  const url = new URL(value, "https://phoenix.invalid");
  if (url.pathname === PHOENIX_CLOUD_CALLBACK_PATH) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

export function savePhoenixCloudBrowserAttempt(
  storage: AttemptStorage,
  state: string,
  attempt: BrowserAttempt,
) {
  // Only routing metadata survives navigation. Codes, tokens and PKCE never enter storage.
  storage.setItem(
    `${ATTEMPT_KEY}${state}`,
    JSON.stringify({ ...attempt, route: safePhoenixCloudReturnRoute(attempt.route) }),
  );
}

export function takePhoenixCloudBrowserAttempt(
  storage: AttemptStorage,
  state: string,
): BrowserAttempt | null {
  const key = `${ATTEMPT_KEY}${state}`;
  const raw = storage.getItem(key);
  storage.removeItem(key);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("environmentId" in value) ||
      !("route" in value) ||
      typeof value.environmentId !== "string" ||
      !value.environmentId ||
      typeof value.route !== "string"
    )
      return null;
    return {
      environmentId: EnvironmentId.make(value.environmentId),
      route: safePhoenixCloudReturnRoute(value.route),
    };
  } catch {
    return null;
  }
}

export function readPhoenixCloudCallback(url: URL): BrowserCallback | null {
  if (url.pathname !== PHOENIX_CLOUD_CALLBACK_PATH) return null;
  const single = (name: string) => {
    const values = url.searchParams.getAll(name);
    return values.length === 1 && values[0] ? values[0] : undefined;
  };
  const state = single("state");
  const iss = single("iss");
  const code = single("code");
  const error = single("error");
  if (
    !state ||
    !iss ||
    Boolean(code) === Boolean(error) ||
    url.searchParams.getAll("code").length > 1 ||
    url.searchParams.getAll("error").length > 1
  )
    return null;
  return {
    state,
    iss,
    ...(code ? { code } : {}),
    ...(error ? { error } : {}),
    returnUrl: `${url.origin}${PHOENIX_CLOUD_CALLBACK_PATH}`,
  };
}

let delivery: { callback: BrowserCallback; attempt: BrowserAttempt } | null = null;

/** Strip the response before routing, error reports, or tracing can observe it. */
export function preparePhoenixCloudBrowserReturn() {
  const url = new URL(window.location.href);
  if (url.pathname !== PHOENIX_CLOUD_CALLBACK_PATH) return;
  const callback = readPhoenixCloudCallback(url);
  window.history.replaceState(window.history.state, "", PHOENIX_CLOUD_CALLBACK_PATH);
  try {
    const attempt = callback
      ? takePhoenixCloudBrowserAttempt(window.sessionStorage, callback.state)
      : null;
    delivery = callback && attempt ? { callback, attempt } : null;
  } catch {
    delivery = null;
  }
}

export const pendingPhoenixCloudBrowserReturn = () => delivery;
export const clearPhoenixCloudBrowserReturn = () => {
  delivery = null;
};
