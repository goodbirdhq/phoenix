import {
  ProviderDriverKind,
  ProviderFailoverGroup,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveProviderFailoverGroupOptions,
  providerInstanceWithFailoverGroup,
  validateProviderFailoverGroupName,
  type ProviderFailoverInstance,
} from "./ProviderFailoverGroups.logic";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const codexGroup = ProviderFailoverGroup.make("codex-accounts");
const claudeGroup = ProviderFailoverGroup.make("claude-accounts");
const oldGroup = ProviderFailoverGroup.make("old-group");

function row(instanceId: string, instance: ProviderInstanceConfig): ProviderFailoverInstance {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    instance,
  };
}

describe("provider failover group presentation", () => {
  const rows = [
    row("codex_work", {
      driver: codex,
      displayName: "Work",
      failoverGroup: codexGroup,
    }),
    row("codex_personal", {
      driver: codex,
      displayName: "Personal",
      failoverGroup: codexGroup,
    }),
    row("codex_spare", { driver: codex }),
    row("claude_work", {
      driver: claude,
      displayName: "Claude Work",
      failoverGroup: claudeGroup,
    }),
  ] as const;

  it("offers only groups from the instance's driver and names their members", () => {
    expect(deriveProviderFailoverGroupOptions(rows, codex)).toEqual([
      {
        name: "codex-accounts",
        memberLabels: ["Work", "Personal"],
      },
    ]);
  });

  it("rejects empty, oversized, and cross-driver group names", () => {
    expect(validateProviderFailoverGroupName("   ", rows, codex)).toBe("Enter a group name.");
    expect(validateProviderFailoverGroupName("x".repeat(65), rows, codex)).toBe(
      "Use a group name with 64 characters or fewer.",
    );
    expect(validateProviderFailoverGroupName("claude-accounts", rows, codex)).toContain(
      "another provider",
    );
  });

  it("accepts a new name or an existing group from the same driver", () => {
    expect(validateProviderFailoverGroupName("evening", rows, codex)).toBeNull();
    expect(validateProviderFailoverGroupName(" codex-accounts ", rows, codex)).toBeNull();
  });
});

describe("provider failover group updates", () => {
  const instance = {
    driver: codex,
    enabled: true,
    displayName: "Work",
    failoverGroup: oldGroup,
    config: { homePath: "/tmp/codex-work" },
  } satisfies ProviderInstanceConfig;

  it("replaces the group tag while preserving the rest of the instance", () => {
    expect(providerInstanceWithFailoverGroup(instance, "  new-group  ")).toEqual({
      ...instance,
      failoverGroup: "new-group",
    });
  });

  it("removes only the group tag when the account becomes ungrouped", () => {
    expect(providerInstanceWithFailoverGroup(instance, null)).toEqual({
      driver: codex,
      enabled: true,
      displayName: "Work",
      config: { homePath: "/tmp/codex-work" },
    });
  });
});
