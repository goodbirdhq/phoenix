import { assert, it } from "@effect/vitest";

import { formatServiceStatus } from "./service.ts";

const status = {
  supported: true,
  installed: true,
  current: true,
  unitPath: "/home/me/.config/systemd/user/phoenix.service",
  logPath: "/home/me/.phoenix/userdata/logs/boot-service.log",
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

it("gives source-build guidance for a stale service", () => {
  assert.include(
    formatServiceStatus({ ...status, current: false }, "0.0.29"),
    "Next: rebuild Phoenix from source and relaunch the service manually.",
  );
});

it("does not advertise installation for a missing service", () => {
  const output = formatServiceStatus({ ...status, installed: false }, "0.0.29");
  assert.include(output, "Automatic installation is unavailable in this source distribution.");
  assert.notInclude(output, "service install");
});

it("explains service availability without systemd", () => {
  assert.include(
    formatServiceStatus({ ...status, supported: false, installed: false }, "0.0.29"),
    "Supported on: Linux with systemd",
  );
});
