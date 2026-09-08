import { environmentConnectionKind } from "./environmentConnectionKind";
import { useAtomCommand } from "../../state/use-atom-command";
import { environmentCatalog } from "../../connection/catalog";
import { mergeHostMetricSamples } from "@t3tools/client-runtime/host-metrics";
import type { EnvironmentId, HostMetricsHistorySample } from "@t3tools/contracts";
import { Link, useSearch, useNavigate } from "@tanstack/react-router";
import { ServerIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useActiveEnvironmentId } from "../../state/entities";
import {
  type EnvironmentHostMetricsStatus,
  useHostMetricsHistory,
  useHostMetricsOverview,
  useLiveHostMetrics,
} from "../../state/hostMetrics";
import { usePrimaryEnvironmentId, useEnvironment } from "../../state/environments";
import { useClientSettings } from "../../hooks/useSettings";
import { EnvironmentIcon } from "./EnvironmentIcon";
import { EnvironmentProjects } from "./EnvironmentProjects";
import { EnvironmentProviders } from "./EnvironmentProviders";
import { EditEnvironmentDialog } from "./EditEnvironmentDialog";
import { EnvironmentHeading } from "./EnvironmentHeading";
import { EnvironmentOverview } from "./EnvironmentOverview";
import { EnvironmentTabs } from "./EnvironmentTabs";
import { EnvironmentConnections } from "./EnvironmentConnections";
import { EnvironmentAccess } from "./EnvironmentAccess";
import { AddEnvironmentDialog } from "./AddEnvironmentDialog";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";

function environmentStateLabel(status: EnvironmentHostMetricsStatus): string {
  if (status.connectionPhase !== "connected") {
    if (status.connectionPhase === "connecting" || status.connectionPhase === "reconnecting") {
      return "Connecting";
    }
    return status.connectionPhase === "error" ? "Connection failed" : "Offline";
  }
  return "Connected";
}

function orderEnvironments(
  environments: readonly EnvironmentHostMetricsStatus[],
  currentEnvironmentId: EnvironmentId | null,
): readonly EnvironmentHostMetricsStatus[] {
  return environments.toSorted((left, right) => {
    if (left.environmentId === currentEnvironmentId) return -1;
    if (right.environmentId === currentEnvironmentId) return 1;
    return left.label.localeCompare(right.label);
  });
}

export function EnvironmentsPage() {
  const environments = useHostMetricsOverview();
  const route = useSearch({ from: "/environments" });
  const navigate = useNavigate();
  const appearance = useClientSettings((s) => s.environmentAppearance);
  const activeEnvironmentId = useActiveEnvironmentId();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const currentEnvironmentId = primaryEnvironmentId ?? activeEnvironmentId;
  const ordered = useMemo(
    () => orderEnvironments(environments, currentEnvironmentId),
    [currentEnvironmentId, environments],
  );
  const selectedEnvironmentId =
    ordered.find((e) => e.environmentId === route.environment)?.environmentId ??
    currentEnvironmentId ??
    ordered[0]?.environmentId ??
    null;
  const selectedPresentation = useEnvironment(selectedEnvironmentId);
  const selected =
    ordered.find((environment) => environment.environmentId === selectedEnvironmentId) ?? null;
  const canReadSelected =
    (!route.tab || route.tab === "overview") &&
    selected?.connectionPhase === "connected" &&
    selected.supportsHostMetrics;
  const live = useLiveHostMetrics(selectedEnvironmentId, canReadSelected);
  const history = useHostMetricsHistory(selectedEnvironmentId, canReadSelected);
  const [liveSamples, setLiveSamples] = useState<readonly HostMetricsHistorySample[]>([]);

  useEffect(() => setLiveSamples([]), [selectedEnvironmentId]);
  useEffect(() => {
    if (!live.data) return;
    const sample: HostMetricsHistorySample = {
      sampledAt: live.data.sampledAt,
      cpuUtilizationPercent: live.data.cpu.utilizationPercent,
      memoryUtilizationPercent:
        live.data.memory.status === "available" && live.data.memory.availabilityKind === "available"
          ? live.data.memory.utilizationPercent
          : null,
    };
    setLiveSamples((current) => mergeHostMetricSamples(current, [sample]));
  }, [live.data]);

  const samples = useMemo(
    () => mergeHostMetricSamples(history.data?.samples ?? [], liveSamples),
    [history.data?.samples, liveSamples],
  );
  const snapshot = live.data ?? selected?.snapshot ?? null;

  return (
    <SidebarInset className="usage-surface environment-surface h-dvh min-h-0 overflow-hidden bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <PageHeader
          label={selected ? appearance[selected.environmentId]?.alias || selected.label : undefined}
        />
        <div className="min-h-0 flex-1">
          <ScrollArea className="h-full min-h-0">
            <main className="mx-auto w-full max-w-[1440px] space-y-6 px-4 py-8 sm:px-8">
              {selected && (
                <>
                  <EnvironmentHeading
                    title={appearance[selected.environmentId]?.alias || selected.label}
                    icon={
                      <EnvironmentIcon
                        environmentId={selected.environmentId}
                        className="size-7 text-muted-foreground"
                      />
                    }
                    description={`${selectedPresentation && environmentConnectionKind(selectedPresentation) === "Local" ? "Local environment" : "Remote environment"}${selected.platform ? ` · ${selected.platform.os} · ${selected.platform.arch}` : ""}${selected.environmentId === primaryEnvironmentId ? " · Current" : ""}`}
                    status={environmentStateLabel(selected)}
                    connected={selected.connectionPhase === "connected"}
                    actions={
                      <Button
                        data-environment-control
                        variant="outline"
                        size="sm"
                        className="h-9 sm:h-9 px-3 text-[13px] sm:text-[13px] shadow-none"
                        onClick={() =>
                          void navigate({ to: "/environments", search: { ...route, edit: true } })
                        }
                      >
                        Edit environment
                      </Button>
                    }
                  />
                </>
              )}
              <EnvironmentTabs
                value={route.tab ?? "overview"}
                onChange={(tab) =>
                  void navigate({ to: "/environments", search: { ...route, tab } })
                }
              >
                {selected === null ? (
                  <EmptyDetail />
                ) : route.tab === "projects" && selected.connectionPhase === "connected" ? (
                  <EnvironmentProjects
                    key={selected.environmentId}
                    environmentId={selected.environmentId}
                    label={appearance[selected.environmentId]?.alias || selected.label}
                  />
                ) : route.tab === "providers" && selected.connectionPhase === "connected" ? (
                  <EnvironmentProviders
                    label={appearance[selected.environmentId]?.alias || selected.label}
                    key={selected.environmentId}
                    environmentId={selected.environmentId}
                  />
                ) : route.tab === "connections" && selectedPresentation ? (
                  <EnvironmentConnections
                    key={selected.environmentId}
                    environment={{
                      ...selectedPresentation,
                      label:
                        appearance[selectedPresentation.environmentId]?.alias ||
                        selectedPresentation.label,
                    }}
                  />
                ) : route.tab === "access" && selected.connectionPhase === "connected" ? (
                  <EnvironmentAccess
                    key={selected.environmentId}
                    environmentId={selected.environmentId}
                  />
                ) : selected.connectionPhase !== "connected" || snapshot === null ? (
                  <UnavailableDetail environment={selected} />
                ) : (
                  <EnvironmentOverview
                    environment={selected}
                    snapshot={snapshot}
                    samples={samples}
                    live={live.data !== null}
                    processDetails={
                      selected.environmentId === primaryEnvironmentId ? (
                        <Button
                          data-environment-control
                          size="sm"
                          variant="outline"
                          className="h-9 sm:h-9 px-3 text-[13px] sm:text-[13px] shadow-none"
                          render={<Link to="/settings/diagnostics" />}
                        >
                          View process details
                        </Button>
                      ) : undefined
                    }
                    refreshing={history.isPending && history.data === null}
                    onRefresh={() => {
                      live.refresh();
                      history.refresh();
                    }}
                  />
                )}
              </EnvironmentTabs>
            </main>
          </ScrollArea>
        </div>
      </div>
      {route.add && (
        <AddEnvironmentDialog
          onClose={() =>
            void navigate({ to: "/environments", search: { ...route, add: undefined } })
          }
          onAdded={(environment) =>
            void navigate({ to: "/environments", search: { tab: "overview", environment } })
          }
        />
      )}
      {route.edit && selectedPresentation && (
        <EditEnvironmentDialog
          key={selectedPresentation.environmentId}
          environment={{
            ...selectedPresentation,
            label:
              appearance[selectedPresentation.environmentId]?.alias || selectedPresentation.label,
          }}
          onClose={() =>
            void navigate({ to: "/environments", search: { ...route, edit: undefined } })
          }
        />
      )}
    </SidebarInset>
  );
}

function PageHeader({ label }: { label?: string | undefined }) {
  return (
    <header
      className={cn(
        "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center border-b border-border/60 px-8 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none",
        isElectron &&
          "drag-region h-[52px] min-h-[52px] wco:h-[env(titlebar-area-height)] wco:min-h-[env(titlebar-area-height)]",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
    >
      <WorkspaceBreadcrumb ariaLabel="Environments breadcrumb">
        <WorkspaceBreadcrumbItem current={!label}>Environments</WorkspaceBreadcrumbItem>
        {label && (
          <>
            <li aria-hidden className="text-muted-foreground">
              /
            </li>
            <WorkspaceBreadcrumbItem current>{label}</WorkspaceBreadcrumbItem>
          </>
        )}
      </WorkspaceBreadcrumb>
    </header>
  );
}

function EmptyDetail() {
  return (
    <div className="py-24 text-center">
      <ServerIcon className="mx-auto size-8 text-muted-foreground/45" />
      <p className="mt-3 text-sm text-muted-foreground">Select an environment to inspect it.</p>
    </div>
  );
}

function UnavailableDetail({ environment }: { environment: EnvironmentHostMetricsStatus }) {
  const navigate = useNavigate();
  const retry = useAtomCommand(environmentCatalog.retryNow, "reconnect environment");
  const [busy, setBusy] = useState(false);
  return (
    <div className="py-24 text-center">
      <ServerIcon className="mx-auto size-8 text-muted-foreground/45" />
      <h2 className="mt-4 text-lg font-semibold">
        {environment.connectionPhase === "connected"
          ? "Metrics unavailable"
          : environment.connectionPhase === "connecting" ||
              environment.connectionPhase === "reconnecting"
            ? "Connecting to environment"
            : "Environment offline"}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        {environment.connectionPhase === "connected" && !environment.supportsHostMetrics
          ? "Update Phoenix on this environment to view host performance metrics."
          : environment.connectionPhase === "connected"
            ? "This environment could not report metrics."
            : "Reconnect this environment to view its projects, providers, access and live metrics."}
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <Button
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await retry(environment.environmentId);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Reconnecting…" : "Retry connection"}
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            void navigate({
              to: "/environments",
              search: { environment: environment.environmentId, tab: "connections" },
            })
          }
        >
          Connection details
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            void navigate({
              to: "/environments",
              search: { environment: environment.environmentId, edit: true },
            })
          }
        >
          Edit environment
        </Button>
      </div>
    </div>
  );
}
