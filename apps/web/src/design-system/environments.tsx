import "../components/environments/environments.css";
import { createRoot } from "react-dom/client";
import * as DateTime from "effect/DateTime";
import {
  EnvironmentId,
  type HostMetricsSnapshot,
  type HostMetricsHistorySample,
} from "@t3tools/contracts";
import { LaptopIcon } from "lucide-react";
import { EnvironmentOverview } from "../components/environments/EnvironmentOverview";
import { EnvironmentHeading } from "../components/environments/EnvironmentHeading";
import { EnvironmentTabs } from "../components/environments/EnvironmentTabs";
import { Button } from "../components/ui/button";
import "../index.css";
import "../components/usage/usage.css";

const now = Date.UTC(2026, 8, 8, 12);
const gib = 1024 ** 3;
const snapshot: HostMetricsSnapshot = {
  sampledAt: DateTime.makeUnsafe(now),
  sampleIntervalMs: 1000,
  cpu: {
    status: "available",
    statusReason: null,
    utilizationPercent: 18,
    loadAverage1m: 1.42,
    loadAverage5m: 1.18,
    loadAverage15m: 0.94,
  },
  memory: {
    status: "available",
    statusReason: null,
    availabilityKind: "available",
    totalBytes: 32 * gib,
    availableBytes: Math.round(19.6 * gib),
    usedBytes: Math.round(12.4 * gib),
    utilizationPercent: 39,
  },
  storage: ["server", "phoenix"].map((kind) => ({
    kind: kind as "server" | "phoenix",
    status: "available",
    totalBytes: 512 * gib,
    availableBytes: 218 * gib,
    usedBytes: 294 * gib,
    utilizationPercent: 57.421875,
  })),
  phoenix: {
    cpuCorePercent: 19.2,
    cpuMachinePercent: 2.4,
    residentBytes: 624 * 1024 ** 2,
    memoryMachinePercent: 1.9,
    processCount: 12,
    ioReadBytesPerSecond: 1024 ** 2,
    ioWriteBytesPerSecond: 0.2 * 1024 ** 2,
    sourceStatus: "healthy",
  },
  inventory: {
    logicalCpuCount: 8,
    totalMemoryBytes: 32 * gib,
    systemUptimeSeconds: (4 * 24 + 12) * 3600,
    serverUptimeSeconds: 6 * 3600 + 24 * 60,
  },
  administrativeDetails: {
    cpuModel: "Apple M3",
    osVersion: "macOS 15.6",
    kernelRelease: "Darwin 24.6.0",
  },
};
const cpu = [
  12, 14, 20, 11, 30, 25, 50, 21, 26, 23, 46, 28, 9, 17, 39, 54, 24, 32, 8, 19, 14, 25, 16, 19,
];
const samples: HostMetricsHistorySample[] = Array.from({ length: 120 }, (_, index) => ({
  sampledAt: DateTime.makeUnsafe(now - (119 - index) * 7500),
  cpuUtilizationPercent: cpu[Math.floor((index * cpu.length) / 120)] ?? 18,
  memoryUtilizationPercent: 38 + index / 60,
}));

function Review() {
  return (
    <div className="usage-surface environment-surface min-h-screen bg-background text-foreground">
      <main className="ml-[344px] w-[1096px]" data-review-frame="overview">
        <nav className="flex h-[52px] items-center gap-3 border-b border-border px-8 text-sm">
          <span>Environments</span>
          <span className="text-muted-foreground">/</span>
          <span className="text-muted-foreground">MacBook Pro</span>
        </nav>
        <div className="space-y-6 p-8">
          <EnvironmentHeading
            title="MacBook Pro"
            icon={<LaptopIcon className="size-7 text-muted-foreground" strokeWidth={1.5} />}
            description="Local environment · macOS · arm64 · Current"
            status="Connected"
            connected
            actions={
              <Button
                size="sm"
                variant="outline"
                className="h-9 sm:h-9 px-3 text-[13px] sm:text-[13px] shadow-none"
              >
                Edit environment
              </Button>
            }
          />
          <EnvironmentTabs value="overview" onChange={() => {}}>
            <EnvironmentOverview
              environment={{
                environmentId: EnvironmentId.make("review-macbook"),
                label: "MacBook Pro",
                platform: null,
                connectionPhase: "connected",
                serverVersion: "1.0.0",
                supportsHostMetrics: true,
                snapshot,
                isPending: false,
                error: null,
              }}
              snapshot={snapshot}
              samples={samples}
              live
              refreshing={false}
              onRefresh={() => {}}
              processDetails={
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 sm:h-9 px-3 text-[13px] sm:text-[13px] shadow-none"
                >
                  View process details
                </Button>
              }
            />
          </EnvironmentTabs>
        </div>
      </main>
    </div>
  );
}

// This separate developer entry is not part of the production application bundle.
if (import.meta.env.DEV) {
  Date.now = () => now;
  const root = document.getElementById("root");
  if (root) createRoot(root).render(<Review />);
}
