const assert = require("node:assert/strict");
const { test } = require("node:test");
const { resolvePublicConfig } = require("./release-public-config.cjs");

test("npm opt-in requires the trusted publisher gate", () => {
  assert.doesNotThrow(() => resolvePublicConfig({}));
  assert.throws(() => resolvePublicConfig({ PUBLISH_NPM: "true" }), /trusted publisher/);
  assert.doesNotThrow(() =>
    resolvePublicConfig({ PUBLISH_NPM: "true", NPM_TRUSTED_PUBLISHING: "true" }),
  );
});
