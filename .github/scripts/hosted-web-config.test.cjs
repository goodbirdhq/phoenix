const assert = require("node:assert/strict");
const { test } = require("node:test");
const keys = ["T3CODE_WEB_ROUTER_URL", "T3CODE_WEB_LATEST_DOMAIN", "T3CODE_WEB_NIGHTLY_DOMAIN"];
let revision = 0;
async function configFor(values) {
  const previous = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    return (await import(`../../apps/web/vercel.ts?test=${revision++}`)).config;
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
}
test("standalone previews do not install channel redirects or upstream rewrites", async () => {
  const config = await configFor({});
  assert.deepEqual(config.routes, []);
  assert.equal(config.git.deploymentEnabled, false);
});
test("hosted routing uses the exact configured Phoenix origins", async () => {
  const config = await configFor({
    T3CODE_WEB_ROUTER_URL: "https://app.phoenix.example",
    T3CODE_WEB_LATEST_DOMAIN: "latest.phoenix.example",
    T3CODE_WEB_NIGHTLY_DOMAIN: "nightly.phoenix.example",
  });
  const forwards = config.routes.filter((route) => route.dest);
  assert.deepEqual(
    forwards.map((route) => route.dest),
    ["https://nightly.phoenix.example/$1", "https://latest.phoenix.example/$1"],
  );
  assert.ok(
    forwards.every((route) =>
      route.has.some(
        (condition) => condition.type === "host" && condition.value === "app.phoenix.example",
      ),
    ),
  );
  assert.ok(!JSON.stringify(config).includes("t3.codes"));
});
test("partial routing configuration fails rather than misrouting a channel", async () => {
  await assert.rejects(
    configFor({ T3CODE_WEB_ROUTER_URL: "https://app.phoenix.example" }),
    /requires router/,
  );
});
