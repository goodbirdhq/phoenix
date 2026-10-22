import { assert, it } from "@effect/vitest";

import { groupDivergence, identityOnlyFiles, registeredPaths } from "./upstream-divergence.ts";

const register = `# Divergence

| Area | Where |
| ---- | ----- |
| Not the register | \`apps/server/src/ignored.ts\` |

## Register

| Area      | Engine | Where                                                    |
| --------- | ------ | -------------------------------------------------------- |
| Telemetry | yes    | \`apps/server/src/telemetry/AnalyticsService.ts\` (\`6157a5da9d\`) |
| Release   | yes    | \`.github/workflows/\`, \`packaging/aur/\`                   |
`;

it("reads only the Where column of the register table", () => {
  assert.deepStrictEqual(registeredPaths(register), [
    "apps/server/src/telemetry/AnalyticsService.ts",
    ".github/workflows/",
    "packaging/aur/",
  ]);
});

it("groups differing files by owner, register coverage, and identity renames", () => {
  const report = groupDivergence({
    files: [
      "apps/web/src/components/sidebar/SidebarFooter.tsx",
      "apps/server/src/telemetry/AnalyticsService.ts",
      "apps/server/src/telemetry/AnalyticsService.test.ts",
      ".github/workflows/release.yml",
      "apps/server/src/config.ts",
      "apps/server/src/orchestration-v2/Orchestrator.ts",
      "apps/server/src/ignored.ts",
    ],
    identityOnly: new Set(["apps/server/src/config.ts"]),
    registered: registeredPaths(register),
  });

  assert.deepStrictEqual(report, {
    phoenix: ["apps/web/src/components/sidebar/SidebarFooter.tsx"],
    registered: [
      ".github/workflows/release.yml",
      "apps/server/src/telemetry/AnalyticsService.test.ts",
      "apps/server/src/telemetry/AnalyticsService.ts",
    ],
    identityOnly: ["apps/server/src/config.ts"],
    unregistered: [
      "apps/server/src/ignored.ts",
      "apps/server/src/orchestration-v2/Orchestrator.ts",
    ],
  });
});

it("counts a file as identity-only when every changed line is a rename", () => {
  const diff = [
    "diff --git a/apps/server/src/config.ts b/apps/server/src/config.ts",
    "--- a/apps/server/src/config.ts",
    "+++ b/apps/server/src/config.ts",
    '-const home = ".t3";',
    '+const home = ".phoenix";',
    "diff --git a/apps/server/src/other.ts b/apps/server/src/other.ts",
    "--- a/apps/server/src/other.ts",
    "+++ b/apps/server/src/other.ts",
    '+const product = "Phoenix";',
    "+const retries = 3;",
  ].join("\n");

  assert.deepStrictEqual([...identityOnlyFiles(diff)], ["apps/server/src/config.ts"]);
});
