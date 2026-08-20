import type { ProviderAvailability } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  SubscriptionAvailabilitySection,
  type SubscriptionAvailabilitySource,
} from "./SubscriptionAvailability";

const availability = {
  status: "available",
  source: "claude_cli_usage",
  observedAt: "2026-08-17T18:00:00.000Z",
  windows: [{ kind: "session", label: "Current session", usedPercent: 24 }],
} satisfies ProviderAvailability;

const source = {
  environmentId: "studio",
  environmentLabel: "Studio",
  instanceId: "claude-work",
  driver: "claudeAgent",
  displayName: "Claude Work",
  accentColor: "#d97706",
  failoverGroup: "work",
  enabled: true,
  authenticated: true,
  availability,
} satisfies SubscriptionAvailabilitySource;

describe("SubscriptionAvailabilitySection", () => {
  it("presents quota as Capacity with a selectable subscriptions lens and readable progress", () => {
    const markup = renderToStaticMarkup(
      <SubscriptionAvailabilitySection sources={[source]} onRefresh={() => undefined} />,
    );

    expect(markup).toContain("Capacity");
    expect(markup).toContain("Available subscriptions");
    expect(markup).toContain("Subscriptions");
    expect(markup).toContain("Instances");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="Refresh capacity"');
    expect(markup).toContain("Current session: 24% used");
    expect(markup).toContain("work");
    expect(markup).toContain("Failover group");
    expect(markup).toContain("1 ready");
    expect(markup).toContain("Environment: Studio");
    expect(markup).not.toContain("Subscription limits");
  });

  it("keeps unconfirmed readings visible and labels their availability honestly", () => {
    const markup = renderToStaticMarkup(
      <SubscriptionAvailabilitySection
        onRefresh={() => undefined}
        sources={[
          {
            ...source,
            availability: { ...availability, status: "unknown" },
          },
        ]}
      />,
    );

    expect(markup).toContain("Availability unknown");
    expect(markup).toContain("could not confirm");
    expect(markup).toContain("Observed");
    expect(markup).toContain("Retry this Provider");
  });

  it("keeps configured group topology visible while only never-read quota fields skeleton", () => {
    const markup = renderToStaticMarkup(
      <SubscriptionAvailabilitySection
        isPending
        sources={[
          {
            ...source,
            availability: { status: "unknown", source: "claude_agent_sdk", windows: [] },
          },
        ]}
      />,
    );

    expect(markup).toContain("Checking capacity");
    expect(markup).toContain("Claude Work");
    expect(markup).toContain("Environment: Studio");
    expect(markup).toContain("Checking provider quota");
  });

  it("marks only a revalidating row busy while retaining its reading", () => {
    const markup = renderToStaticMarkup(
      <SubscriptionAvailabilitySection
        onRefresh={() => undefined}
        sources={[
          {
            ...source,
            isRefreshing: true,
            availability: { ...availability, status: "unknown" },
          },
        ]}
      />,
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Updating last reading");
    expect(markup).toContain("Current session: 24% used");
    expect(markup).not.toContain("Retry this Provider");
  });

  it("retains unsupported ungrouped Providers without implying a quota reading", () => {
    const markup = renderToStaticMarkup(
      <SubscriptionAvailabilitySection
        sources={[
          {
            ...source,
            driver: "cursor",
            failoverGroup: undefined,
            availability: { status: "unknown", source: "unsupported", windows: [] },
          },
        ]}
      />,
    );

    expect(markup).toContain("Ungrouped");
    expect(markup).toContain("never switch automatically");
    expect(markup).toContain("Limits not reported");
    expect(markup).toContain("Manage Provider");
  });
});
