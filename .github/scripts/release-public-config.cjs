const fs = require("node:fs");

function value(env, name) {
  const raw = env[name] ?? "";
  if (/[\r\n]/.test(raw)) throw new Error(`${name} must be a single line`);
  return raw.trim();
}

function httpsOrigin(raw, name) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an HTTPS origin`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(`${name} must be an HTTPS origin without credentials, path, query or fragment`);
  }
  return url.origin;
}

function phoenixHost(raw, name) {
  const origin = httpsOrigin(`https://${raw}`, name);
  const url = new URL(origin);
  if (
    url.port ||
    url.host !== raw ||
    url.hostname === "t3.codes" ||
    url.hostname.endsWith(".t3.codes")
  ) {
    throw new Error(
      `${name} must be an explicit Phoenix hostname, not an upstream t3.codes target`,
    );
  }
  return url.host;
}

function resolvePublicConfig(env) {
  const relayUrl = value(env, "T3CODE_RELAY_URL");
  const result = {
    relay_url: relayUrl ? httpsOrigin(relayUrl, "T3CODE_RELAY_URL") : "",
    web_router_url: "",
    web_latest_domain: "",
    web_nightly_domain: "",
  };
  if (env.PUBLISH_NPM === "true" && env.NPM_TRUSTED_PUBLISHING !== "true") {
    throw new Error(
      "Requested npm publication requires NPM_TRUSTED_PUBLISHING=true and the npm trusted publisher setup",
    );
  }
  if (env.PUBLISH_WEB === "true") {
    const router = httpsOrigin(value(env, "T3CODE_WEB_ROUTER_URL"), "T3CODE_WEB_ROUTER_URL");
    phoenixHost(new URL(router).host, "T3CODE_WEB_ROUTER_URL");
    result.web_router_url = router;
    result.web_latest_domain = phoenixHost(
      value(env, "T3CODE_WEB_LATEST_DOMAIN"),
      "T3CODE_WEB_LATEST_DOMAIN",
    );
    result.web_nightly_domain = phoenixHost(
      value(env, "T3CODE_WEB_NIGHTLY_DOMAIN"),
      "T3CODE_WEB_NIGHTLY_DOMAIN",
    );
    if (
      new Set([new URL(router).host, result.web_latest_domain, result.web_nightly_domain]).size !==
      3
    ) {
      throw new Error("Hosted-web router, latest and nightly domains must be distinct");
    }
  }
  return result;
}

if (require.main === module) {
  const outputs = resolvePublicConfig(process.env);
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs)
      .map(([key, val]) => `${key}=${val}\n`)
      .join(""),
  );
}
module.exports = { resolvePublicConfig };
