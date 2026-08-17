import { assert, it } from "@effect/vitest";

import { formatServiceStatus } from "./service.ts";

const status = {
  supported: true,
  installed: true,
  current: true,
  unitPath: "/home/me/.config/systemd/user/phoenix.service",
  logPath: "/home/me/.phoenix/userdata/logs/boot-service.log",
} as const;

it("reports the installed service version and host paths", () => {
  assert.equal(
    formatServiceStatus(status, "0.0.29"),
    [
      "Phoenix service",
      "  Status: installed · phoenix@0.0.29",
      "  Unit: /home/me/.config/systemd/user/phoenix.service",
      "  Logs: /home/me/.phoenix/userdata/logs/boot-service.log",
    ].join("\n"),
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
