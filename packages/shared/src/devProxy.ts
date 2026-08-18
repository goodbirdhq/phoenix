/**
 * Backend paths the web dev server proxies in single-origin browser dev.
 *
 * Two consumers must agree on this list: the Vite proxy map
 * (apps/web/vite.config.ts) that forwards these to the backend, and the
 * server's dev catch-all (apps/server/src/http.ts) that 404s them instead of
 * redirecting back to Vite. Drift is silent and nasty in both directions — a
 * prefix only Vite knows gets answered with index.html; a prefix only the
 * server knows redirect-loops through the proxy.
 */
export const DEV_PROXIED_PATH_PREFIXES = ["/api", "/oauth", "/.well-known", "/ws"] as const;

/**
 * Shared Vite-compatible proxy entries for browser development. Keeping the
 * `/ws` upgrade flag next to the path list makes request and upgrade routing
 * impossible to accidentally configure differently.
 */
export function createDevProxyEntries(target: string | undefined) {
  if (!target) return undefined;
  return Object.fromEntries(
    DEV_PROXIED_PATH_PREFIXES.map((prefix) => [
      prefix,
      {
        target,
        changeOrigin: true,
        ...(prefix === "/ws" ? { ws: true } : {}),
      },
    ]),
  );
}

export function isDevProxiedPath(pathname: string): boolean {
  return DEV_PROXIED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
