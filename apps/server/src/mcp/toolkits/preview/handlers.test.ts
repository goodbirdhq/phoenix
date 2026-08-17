import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { normalizePreviewOpenInput, requirePreviewCapability } from "./handlers.ts";

describe("normalizePreviewOpenInput", () => {
  it("leaves an unstated visibility for the client preference to decide", () => {
    // Filling `open` in here would outrank `browserAutoShowFloatingPreview`,
    // which is desktop-local and cannot be read from the server.
    expect(normalizePreviewOpenInput({})).toEqual({ reuseExistingTab: true });
  });

  it("preserves an explicit background-only opt-out", () => {
    expect(normalizePreviewOpenInput({ open: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
  });

  it("supports show as a legacy alias while preferring open", () => {
    expect(normalizePreviewOpenInput({ show: false })).toEqual({
      open: false,
      reuseExistingTab: true,
      show: false,
    });
    expect(normalizePreviewOpenInput({ open: true, show: false })).toEqual({
      open: true,
      reuseExistingTab: true,
      show: true,
    });
  });
});

describe("requirePreviewCapability", () => {
  it.effect("applies browser access setting changes to an existing MCP credential", () => {
    const invocation: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("environment-preview-test"),
      threadId: ThreadId.make("thread-preview-test"),
      providerSessionId: "provider-session-preview-test",
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
      issuedAt: 1,
    };

    return Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      expect((yield* requirePreviewCapability()).threadId).toBe(invocation.threadId);

      yield* settings.updateSettings({ enableAgentBrowserAccess: false });
      const denied = yield* Effect.exit(requirePreviewCapability());
      expect(denied._tag).toBe("Failure");
    }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provide(ServerSettings.layerTest({ enableAgentBrowserAccess: true })),
    );
  });
});
