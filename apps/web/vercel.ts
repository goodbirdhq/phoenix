import { matchers, routes, type Transform, type VercelConfig } from "@vercel/config/v1";

// Releases provide all three explicit Phoenix targets. Standalone previews
// omit them and must never forward traffic to an inherited upstream host.
const routerUrl = process.env.T3CODE_WEB_ROUTER_URL?.trim() ?? "";
const latestDomain = process.env.T3CODE_WEB_LATEST_DOMAIN?.trim() ?? "";
const nightlyDomain = process.env.T3CODE_WEB_NIGHTLY_DOMAIN?.trim() ?? "";
const hasRouter = [routerUrl, latestDomain, nightlyDomain].some(Boolean);
if (hasRouter && ![routerUrl, latestDomain, nightlyDomain].every(Boolean)) {
  throw new Error("Hosted routing requires router, latest and nightly targets together");
}
const ROUTER_HOST = hasRouter ? new URL(routerUrl).host : "";
const HOSTED_WEB_CHANNEL_COOKIE = "t3code_web_channel";
const LATEST_ORIGIN = `https://${latestDomain}`;
const NIGHTLY_ORIGIN = `https://${nightlyDomain}`;
const CLEAN_CHANNEL_QUERY_TRANSFORMS = [
  {
    type: "request.query",
    op: "delete",
    target: { key: "channel" },
  },
] satisfies Transform[];

function channelCookie(channel: "latest" | "nightly"): string {
  return [
    `${HOSTED_WEB_CHANNEL_COOKIE}=${channel}`,
    "Path=/",
    "Max-Age=31536000",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export const config: VercelConfig = {
  buildCommand:
    'vp run --filter @t3tools/web build && node ../../scripts/apply-web-brand-assets.ts --channel "${VITE_HOSTED_APP_CHANNEL:-latest}"',
  git: {
    deploymentEnabled: false,
  },
  installCommand:
    "npm install -g vite-plus && vp install --ignore-scripts --filter '@t3tools/scripts...' --filter '@t3tools/web...'",
  routes: hasRouter
    ? [
        {
          src: "/__t3code/channel",
          has: [matchers.query("channel", "nightly")],
          transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
          headers: {
            Location: "/",
            "Set-Cookie": channelCookie("nightly"),
          },
          status: 302,
        },
        {
          src: "/__t3code/channel",
          transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
          headers: {
            Location: "/",
            "Set-Cookie": channelCookie("latest"),
          },
          status: 302,
        },
        {
          src: "/(.*)",
          has: [matchers.host(ROUTER_HOST), matchers.cookie(HOSTED_WEB_CHANNEL_COOKIE, "nightly")],
          dest: `${NIGHTLY_ORIGIN}/$1`,
        },
        {
          src: "/(.*)",
          has: [matchers.host(ROUTER_HOST)],
          dest: `${LATEST_ORIGIN}/$1`,
        },
      ]
    : [],
  rewrites: [routes.rewrite("/(.*)", "/index.html")],
};
