import type { ProviderAvailability } from "@t3tools/contracts";
import type { AnchorHTMLAttributes } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, ...props }: { readonly to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...props} />
  ),
}));

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
  availabilityRefreshSupported: true,
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

  it("keeps an expired reading visible and labels it unconfirmed", () => {
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

    expect(markup).toContain("Previous reading expired");
    expect(markup).toContain("previous quota reading is retained but unconfirmed");
    expect(markup).toContain("Observed");
    expect(markup).toContain("Retry this Provider");
  });

  it("keeps a failed reading visible without counting it ready and offers targeted retry", () => {
    const markup = renderToStaticMarkup(
      <SubscriptionAvailabilitySection
        onRefresh={() => undefined}
        sources={[
          {
            ...source,
            availability: {
              ...availability,
              stale: { reason: "refresh_failed", attemptedAt: "2026-08-17T19:00:00.000Z" },
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Refresh failed — previous reading unconfirmed");
    expect(markup).toContain("Retry this Provider");
    expect(markup).toContain("Current session 24%");
    expect(markup).toContain("Unknown");
  });

  it("distinguishes an unauthenticated Provider from an unread Provider", () => {
    const markup = renderToStaticMarkup(
      <SubscriptionAvailabilitySection
        sources={[
          {
            ...source,
            authenticated: false,
            availability: { status: "unknown", source: "claude_agent_sdk", windows: [] },
          },
        ]}
      />,
    );

    expect(markup).toContain("Provider not authenticated");
    expect(markup).toContain("Sign in to this Provider");
    expect(markup).not.toContain("No quota reading has been collected");
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
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Claude Work");
    expect(markup).toContain("Environment: Studio");
    expect(markup).toContain("Checking provider quota");
  });

  it("distinguishes never-collected and failed empty readings after loading settles", () => {
    const neverCollected = renderToStaticMarkup(
      <SubscriptionAvailabilitySection
        sources={[
          {
            ...source,
            availability: { status: "unknown", source: "claude_agent_sdk", windows: [] },
          },
        ]}
      />,
    );
    const failed = renderToStaticMarkup(
      <SubscriptionAvailabilitySection
        sources={[
          {
            ...source,
            availability: {
              status: "unknown",
              source: "claude_cli_usage",
              observedAt: "2026-08-17T19:00:00.000Z",
              windows: [],
            },
          },
        ]}
      />,
    );

    expect(neverCollected).toContain("No quota reading has been collected");
    expect(failed).toContain("could not confirm that these quota limits are current");
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
    expect(markup).not.toContain("Cursor 0 of 1 ready");
  });

  it("keeps partial Environment errors visible beside retained Capacity data", () => {
    const markup = renderToStaticMarkup(
      <SubscriptionAvailabilitySection sources={[source]} hasError />,
    );

    expect(markup).toContain("Some capacity readings could not be refreshed");
    expect(markup).toContain("Claude Work");
  });

  it("describes shared subscriptions with Provider labels rather than internal ids", () => {
    const account = {
      id: "shared-account",
      verification: "native_verified" as const,
      displayName: "Team account",
    };
    const markup = renderToStaticMarkup(
      <SubscriptionAvailabilitySection
        sources={[
          { ...source, displayName: "Claude Work", availability: { ...availability, account } },
          {
            ...source,
            instanceId: "claude-backup-internal-id",
            displayName: "Claude Backup",
            availability: { ...availability, account },
          },
        ]}
      />,
    );

    expect(markup).toContain("Shares a subscription with Claude Backup, Claude Work");
    expect(markup).not.toContain("claude-backup-internal-id");
  });
});
