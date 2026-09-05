import { assert, it } from "@effect/vitest";

import { formatServiceStatus, formatServiceUnchanged } from "./service.ts";

const status = {
  supported: true,
  installed: true,
  current: true,
  unitPath: "/home/me/.config/systemd/user/phoenix.service",
  logPath: "/home/me/.phoenix/userdata/logs/boot-service.log",
  activeVersion: "0.0.29",
  runtimeVersion: "phoenix v0.0.29 (b421b138)",
} as const;

it("reports the installed service version and host paths", () => {
  assert.equal(
    formatServiceStatus(status, "0.0.29", "0.0.29 (b421b138)"),
    [
      "Phoenix service",
      "  Status: installed · phoenix@0.0.29",
      "  Service build: phoenix v0.0.29 (b421b138)",
      "  CLI build: 0.0.29 (b421b138)",
      "  Unit: /home/me/.config/systemd/user/phoenix.service",
      "  Logs: /home/me/.phoenix/userdata/logs/boot-service.log",
    ].join("\n"),
  );
});

it("shows the drift when the CLI has moved ahead of the running service", () => {
  const output = formatServiceStatus(status, "0.0.29", "0.0.30 (ff00ff00)");

  assert.include(output, "  Service build: phoenix v0.0.29 (b421b138)");
  assert.include(output, "  CLI build: 0.0.30 (ff00ff00)");
});

it("says the service build is unavailable rather than borrowing the CLI's", () => {
  assert.include(
    formatServiceStatus({ ...status, runtimeVersion: null }, "0.0.29", "0.0.29 (b421b138)"),
    "  Service build: unavailable",
  );
});

it("points a stale service at the published update command", () => {
  assert.include(
    formatServiceStatus({ ...status, current: false }, "0.0.29"),
    "Next: Run `npx @goodbirdhq/phoenix@latest service update`.",
  );
});

it("does not tell an older CLI to repair a newer service", () => {
  const output = formatServiceStatus(
    {
      ...status,
      current: false,
      activeVersion: "0.1.2",
      runtimeVersion: "phoenix v0.1.2 (abc12345)",
    },
    "0.1.0",
    "0.1.0 (oldold01)",
  );

  assert.include(output, "installed · phoenix@0.1.2 (newer than this CLI)");
  assert.include(output, "  Service build: phoenix v0.1.2 (abc12345)");
  assert.equal(output.includes("needs an update or repair"), false);
  assert.equal(output.includes("Next: Run `npx"), false);
});

it("tells an older CLI to use npx @latest instead of claiming a successful update", () => {
  assert.equal(
    formatServiceUnchanged(
      { ...status, current: false, activeVersion: "0.1.2" },
      "0.1.0",
      "update",
    ),
    [
      "Phoenix service is already on phoenix@0.1.2, newer than this CLI (0.1.0).",
      "Use `npx @goodbirdhq/phoenix@latest service update` to update.",
    ].join("\n"),
  );
});

it("advertises installation for a missing service", () => {
  const output = formatServiceStatus({ ...status, installed: false }, "0.0.29");
  assert.include(output, "Next: Run `phoenix service install`.");
});

it("explains where the service is supported", () => {
  assert.include(
    formatServiceStatus({ ...status, supported: false, installed: false }, "0.0.29"),
    "Supported on: Linux with systemd, macOS with launchd",
  );
});
