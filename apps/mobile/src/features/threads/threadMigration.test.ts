import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderGroup } from "../../lib/modelOptions";
import {
  activeThreadsBoundToInstance,
  readyThreadProviderGroups,
  resolveMigrationTargetModel,
  threadHasStarted,
  threadTurnIsStreaming,
} from "./threadMigration";

const provider = (
  instanceId: string,
  driver: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  displayName: instanceId,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-19T12:00:00.000Z",
  models: [
    {
      slug: "default-model",
      name: "Default",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const group = (providerKey: string): ProviderGroup => ({
  providerKey,
  providerLabel: providerKey,
  models: [],
});

const shell = (
  id: string,
  instanceId: string,
  sessionInstanceId?: string,
): EnvironmentThreadShell => ({
  environmentId: EnvironmentId.make("environment"),
  id: ThreadId.make(id),
  projectId: ProjectId.make("project"),
  title: id,
  modelSelection: {
    instanceId: ProviderInstanceId.make(instanceId),
    model: "model",
  },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-08-19T12:00:00.000Z",
  updatedAt: "2026-08-19T12:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  session: sessionInstanceId
    ? {
        threadId: ThreadId.make(id),
        status: "ready",
        providerName: null,
        providerInstanceId: ProviderInstanceId.make(sessionInstanceId),
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-08-19T12:00:00.000Z",
      }
    : null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

describe("mobile thread migration glue", () => {
  it("offers the bound instance and every other ready instance", () => {
    expect(
      readyThreadProviderGroups({
        groups: [group("origin"), group("ready"), group("warning"), group("missing")],
        providers: [
          provider("origin", "claudeAgent", { status: "warning" }),
          provider("ready", "codex"),
          provider("warning", "codex", { status: "warning" }),
          provider("missing", "codex", {
            availability: "unavailable",
            enabled: false,
            installed: false,
          }),
        ],
        boundInstanceId: ProviderInstanceId.make("origin"),
      }).map((entry) => entry.providerKey),
    ).toEqual(["origin", "ready"]);
  });

  it("preserves a same-driver model and otherwise selects the target default", () => {
    const target = provider("target", "claudeAgent", {
      models: [
        {
          slug: "current-model",
          name: "Current",
          isCustom: false,
          capabilities: null,
        },
        {
          slug: "fallback",
          name: "Fallback",
          isCustom: false,
          isDefault: true,
          capabilities: null,
        },
      ],
    });
    expect(
      resolveMigrationTargetModel({
        originDriverKind: ProviderDriverKind.make("claudeAgent"),
        targetProvider: target,
        currentModel: "current-model",
      }),
    ).toBe("current-model");
    expect(
      resolveMigrationTargetModel({
        originDriverKind: ProviderDriverKind.make("codex"),
        targetProvider: target,
        currentModel: "current-model",
      }),
    ).toBe("fallback");
  });

  it("uses session binding for bulk eligibility and excludes archived threads", () => {
    const persisted = shell("persisted", "origin");
    const rebound = shell("rebound", "other", "origin");
    const pickerOnly = shell("picker", "origin", "other");
    const archived = { ...shell("archived", "origin"), archivedAt: "2026-08-19T12:00:00.000Z" };
    expect(
      activeThreadsBoundToInstance({
        threads: [persisted, rebound, pickerOnly, archived],
        environmentId: EnvironmentId.make("environment"),
        instanceId: ProviderInstanceId.make("origin"),
      }).map((thread) => thread.id),
    ).toEqual([persisted.id, rebound.id]);
  });

  it("treats either live session or latest turn state as streaming", () => {
    expect(
      threadTurnIsStreaming({ session: { status: "running" }, latestTurn: null } as never),
    ).toBe(true);
    expect(
      threadTurnIsStreaming({
        session: null,
        latestTurn: { state: "running" },
      } as never),
    ).toBe(true);
  });

  it("treats a durable turn as started even after its session closes", () => {
    expect(threadHasStarted({ latestTurn: { state: "completed" }, session: null } as never)).toBe(
      true,
    );
    expect(threadHasStarted({ latestTurn: null, session: null })).toBe(false);
  });
});
