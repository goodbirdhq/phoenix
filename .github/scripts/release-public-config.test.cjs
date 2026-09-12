const assert = require("node:assert/strict");
const { test } = require("node:test");
const { resolvePublicConfig } = require("./release-public-config.cjs");

const connect = {
  CLERK_PUBLISHABLE_KEY: "pk_test_example",
  CLERK_JWT_TEMPLATE: "phoenix",
  CLERK_CLI_OAUTH_CLIENT_ID: "client_example",
  T3CODE_RELAY_URL: "https://relay.phoenix.example/",
};
const web = {
  PUBLISH_WEB: "true",
  T3CODE_WEB_ROUTER_URL: "https://app.phoenix.example",
  T3CODE_WEB_LATEST_DOMAIN: "latest.phoenix.example",
  T3CODE_WEB_NIGHTLY_DOMAIN: "nightly.phoenix.example",
};
test("unconfigured releases have no inherited Connect or hosted destinations", () => {
  assert.ok(Object.values(resolvePublicConfig({})).every((value) => value === ""));
});
test("complete Connect configuration normalizes the relay origin", () => {
  assert.equal(resolvePublicConfig(connect).relay_url, "https://relay.phoenix.example");
});
test("every partial Connect tuple fails, including a lone field", () => {
  const entries = Object.entries(connect);
  for (let mask = 1; mask < 15; mask++) {
    assert.throws(
      () => resolvePublicConfig(Object.fromEntries(entries.filter((_, i) => mask & (1 << i)))),
      /requires all/,
    );
  }
});
test("invalid relay URLs and workflow-output injection fail", () => {
  for (const url of [
    "http://relay.example",
    "https://user:pass@relay.example",
    "https://relay.example/path",
    "https://relay.example?key=x",
    "https://relay.example#x",
  ]) {
    assert.throws(() => resolvePublicConfig({ ...connect, T3CODE_RELAY_URL: url }), /HTTPS origin/);
  }
  assert.throws(
    () => resolvePublicConfig({ ...connect, CLERK_JWT_TEMPLATE: "x\ninjected=true" }),
    /single line/,
  );
});
test("hosted web supports explicit targets with or without Connect", () => {
  for (const config of [web, { ...web, ...connect }]) {
    assert.equal(resolvePublicConfig(config).web_latest_domain, web.T3CODE_WEB_LATEST_DOMAIN);
  }
});
test("hosted publication rejects missing, upstream, malformed and overlapping targets", () => {
  for (const key of Object.keys(web).filter((key) => key !== "PUBLISH_WEB")) {
    assert.throws(() => resolvePublicConfig({ ...web, [key]: "" }));
  }
  for (const domain of [
    "latest.app.t3.codes",
    "t3.codes",
    "latest.example/path",
    "latest.example:8443",
    "latest.example\nother=x",
  ]) {
    assert.throws(() => resolvePublicConfig({ ...web, T3CODE_WEB_LATEST_DOMAIN: domain }));
  }
  assert.throws(() =>
    resolvePublicConfig({ ...web, T3CODE_WEB_ROUTER_URL: "https://app.t3.codes" }),
  );
  assert.throws(
    () => resolvePublicConfig({ ...web, T3CODE_WEB_NIGHTLY_DOMAIN: web.T3CODE_WEB_LATEST_DOMAIN }),
    /distinct/,
  );
});
test("npm opt-in requires the trusted publisher gate", () => {
  assert.throws(() => resolvePublicConfig({ PUBLISH_NPM: "true" }), /trusted publisher/);
  assert.doesNotThrow(() =>
    resolvePublicConfig({ PUBLISH_NPM: "true", NPM_TRUSTED_PUBLISHING: "true" }),
  );
});
