import type { ThreadUsageWarning } from "@t3tools/client-runtime/usage/usage-warning";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { UsageLimitWarningBanner } from "./UsageLimitWarningBanner";

function warning(overrides: Partial<ThreadUsageWarning> = {}): ThreadUsageWarning {
  return {
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    accountName: "neil@goodbird.ai",
    windowLabel: "Current session",
    usedPercent: 94,
    resetsAt: "2026-08-19T14:00:00.000Z",
    isReadingUnconfirmed: false,
    dismissalKey: "thread-1 | claudeAgent | session: | 2026-08-19T14:00:00.000Z",
    ...overrides,
  };
}

describe("UsageLimitWarningBanner", () => {
  it("says which account, how spent it is, and when it resets", () => {
    const markup = renderToStaticMarkup(
      <UsageLimitWarningBanner warning={warning()} onDismiss={() => {}} />,
    );

    expect(markup).toContain("neil@goodbird.ai");
    expect(markup).toContain("94%");
    expect(markup).toContain("current session");
    expect(markup).toContain("resets");
    expect(markup).toContain('aria-label="Dismiss neil@goodbird.ai usage warning"');
  });

  it("renders nothing when the account is not near a limit", () => {
    expect(
      renderToStaticMarkup(<UsageLimitWarningBanner warning={null} onDismiss={() => {}} />),
    ).toBe("");
  });

  it("marks an unconfirmed reading rather than presenting it as current", () => {
    const markup = renderToStaticMarkup(
      <UsageLimitWarningBanner
        warning={warning({ isReadingUnconfirmed: true })}
        onDismiss={() => {}}
      />,
    );

    expect(markup).toContain("last known reading");
  });

  it("carries an action slot for the hand-off control that lands later", () => {
    const markup = renderToStaticMarkup(
      <UsageLimitWarningBanner
        warning={warning()}
        onDismiss={() => {}}
        action={<button type="button">Hand off</button>}
      />,
    );

    expect(markup).toContain("Hand off");
  });
});
