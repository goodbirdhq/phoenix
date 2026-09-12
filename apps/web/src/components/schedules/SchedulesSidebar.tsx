import { describeScheduleCadence } from "@t3tools/shared/scheduleCadence";
import {
  aggregateSchedules,
  filterScheduleRows,
  type ScheduleFilters,
  type AggregatedScheduleRow,
} from "@t3tools/client-runtime/schedules";
import {
  ScheduleId,
  type EnvironmentId,
  type ProjectId,
  type ScheduleState,
} from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
  ListFilterIcon,
  PauseIcon,
  RepeatIcon,
  PlusIcon,
  SearchIcon,
  WifiOffIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useClientSettings } from "../../hooks/useSettings";
import { useProjects } from "../../state/entities";
import { scheduleEnvironment, useWebEnvironmentSchedules } from "../../state/schedules";
import { useEnvironmentQuery } from "../../state/query";
import { randomUUID, cn } from "../../lib/utils";
import { EnvironmentIcon } from "../environments/EnvironmentIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { SidebarContent, useSidebar } from "../ui/sidebar";
import { SidebarChromeFooter } from "../sidebar/SidebarChrome";
import { Button } from "../ui/button";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuCheckboxItem,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
} from "../ui/menu";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { ScheduleActions } from "./ScheduleActions";
import { compareScheduleSidebarRows } from "./SchedulesPage.logic";

const states = ["failed", "enabled", "paused", "completed"] as const;
const stateIcons = {
  failed: CircleAlertIcon,
  enabled: ClockIcon,
  paused: PauseIcon,
  completed: CircleCheckIcon,
};
const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function SchedulesSidebar() {
  const { isReady, environments } = useWebEnvironmentSchedules();
  const projects = useProjects();
  const appearance = useClientSettings((s) => s.environmentAppearance);
  const route = useSearch({ strict: false });
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [query, setQuery] = useState("");
  const [environmentIds, setEnvironmentIds] = useState<string[]>([]);
  const [projectKeys, setProjectKeys] = useState<string[]>([]);
  const [selectedStates, setSelectedStates] = useState<ScheduleState[]>([]);
  const [failures, setFailures] = useState<ScheduleFilters["failures"]>("all");
  const [expanded, setExpanded] = useLocalStorage(
    "phoenix:schedule-expanded-sections",
    ["failed", "enabled"],
    Schema.Array(Schema.String),
  );
  const rows = useMemo(
    () =>
      aggregateSchedules(
        environments.map((e) => ({
          ...e,
          environmentId: e.environment.environmentId,
          environmentLabel: appearance[e.environment.environmentId]?.alias || e.environment.label,
        })),
      ),
    [environments, appearance],
  );
  const projectByKey = new Map(projects.map((p) => [`${p.environmentId}:${p.id}`, p]));
  const filtered = filterScheduleRows(rows, {
    environmentIds: new Set(environmentIds as EnvironmentId[]),
    projectIds: new Set<ProjectId>(),
    states: new Set(selectedStates),
    failures,
  }).filter(
    (row) =>
      (!projectKeys.length || projectKeys.includes(`${row.environmentId}:${row.projectId}`)) &&
      `${row.name} ${row.environmentLabel} ${projectByKey.get(`${row.environmentId}:${row.projectId}`)?.title ?? ""}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  const count =
    Number(environmentIds.length > 0) +
    Number(projectKeys.length > 0) +
    Number(selectedStates.length > 0) +
    Number(failures !== "all");
  const clear = () => {
    setEnvironmentIds([]);
    setProjectKeys([]);
    setSelectedStates([]);
    setFailures("all");
  };
  const toggle = (list: readonly string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  const selected =
    rows.find((row) => row.environmentId === route.environment && row.id === route.schedule) ??
    (!route.schedule ? rows[0] : undefined);
  useEffect(() => {
    if (selected)
      setExpanded((current) =>
        current.includes(selected.state) ? current : [...current, selected.state],
      );
  }, [selected?.environmentId, selected?.id, selected?.state]);
  return (
    <>
      <div className="flex h-[52px] shrink-0 items-center gap-1 px-4">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
          <SearchIcon className="size-4 shrink-0" />
          <input
            aria-label="Search schedules by name, project or environment"
            placeholder="Search schedules"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className="relative size-8"
                aria-label={`Filter schedules (${count})`}
              />
            }
          >
            <ListFilterIcon className="size-4" />
            {count > 0 && (
              <span className="absolute -top-0.5 -right-0.5 rounded-full bg-foreground px-1 text-[9px] text-background">
                {count}
              </span>
            )}
          </MenuTrigger>
          <MenuPopup align="end" className="w-60">
            <div className="px-2 py-2 text-xs font-medium">Filter schedules</div>
            <FilterGroup
              label="Projects"
              selected={projectKeys}
              options={projects.map((p) => ({
                value: `${p.environmentId}:${p.id}`,
                label: p.title,
                detail:
                  environments.find((e) => e.environment.environmentId === p.environmentId)
                    ?.environment.label ?? "Unavailable environment",
              }))}
              onToggle={(v) => setProjectKeys(toggle(projectKeys, v))}
              onClear={() => setProjectKeys([])}
              searchable
            />
            <FilterGroup
              label="Environments"
              selected={environmentIds}
              options={environments.map((e) => ({
                value: e.environment.environmentId,
                label: appearance[e.environment.environmentId]?.alias || e.environment.label,
                detail: e.online ? "Connected" : "Offline",
              }))}
              onToggle={(v) => setEnvironmentIds(toggle(environmentIds, v))}
              onClear={() => setEnvironmentIds([])}
              searchable
            />
            <FilterGroup
              label="State"
              selected={selectedStates}
              options={states.map((s) => ({ value: s, label: title(s) }))}
              onToggle={(v) => setSelectedStates(toggle(selectedStates, v) as ScheduleState[])}
              onClear={() => setSelectedStates([])}
            />
            <FilterGroup
              label="Failures"
              selected={failures === "all" ? [] : [failures]}
              options={[
                { value: "all", label: "All schedules" },
                { value: "only", label: "With failures" },
                { value: "without", label: "Without failures" },
              ]}
              onToggle={(v) => setFailures(v as ScheduleFilters["failures"])}
              onClear={() => setFailures("all")}
            />
            <MenuItem onClick={clear}>Clear all filters</MenuItem>
          </MenuPopup>
        </Menu>
        <Button
          size="icon"
          className="size-8 bg-sky-600 text-white hover:bg-sky-700"
          aria-label="Create schedule"
          onClick={() => {
            void navigate({ to: "/schedules", search: { create: randomUUID() } });
            if (isMobile) setOpenMobile(false);
          }}
        >
          <PlusIcon className="size-[18px]" />
        </Button>
      </div>
      <SidebarContent className="schedule-sidebar">
        <div className="flex flex-col gap-0.5 px-2.5 py-2">
          {!isReady && (
            <p role="status" className="p-3 text-sm text-muted-foreground">
              Loading environments…
            </p>
          )}
          {environments
            .filter((e) => e.error || !e.hasSnapshot)
            .map((e) => (
              <p
                key={e.environment.environmentId}
                role={e.error ? "alert" : "status"}
                className="p-3 text-xs text-muted-foreground"
              >
                {e.environment.label}:{" "}
                {e.error ??
                  (!e.online
                    ? "Offline — no cached schedules."
                    : !e.supportsSchedules
                      ? "Schedules unavailable. Update this environment."
                      : "Loading schedules…")}
              </p>
            ))}
          {states.map((state) => {
            const items = filtered
              .filter((row) => row.state === state)
              .toSorted(compareScheduleSidebarRows);
            if (!items.length) return null;
            const Icon = stateIcons[state];
            const open = expanded.includes(state) || !!query || count > 0;
            return (
              <section key={state} className="contents">
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setExpanded(toggle(expanded, state))}
                  className="flex h-[38px] w-full items-center gap-2 px-2 text-xs text-muted-foreground"
                >
                  <Icon className="size-[13px]" />
                  <span className="flex-1 text-left">
                    {title(state)} · {items.length}
                  </span>
                  {open ? (
                    <ChevronDownIcon className="size-3" />
                  ) : (
                    <ChevronRightIcon className="size-3" />
                  )}
                </button>
                {open &&
                  items.map((row) => (
                    <ScheduleSidebarRow
                      key={`${row.environmentId}:${row.id}`}
                      row={row}
                      project={projectByKey.get(`${row.environmentId}:${row.projectId}`)}
                      selected={
                        selected?.id === row.id && selected.environmentId === row.environmentId
                      }
                      onSelect={() => {
                        void navigate({
                          to: "/schedules",
                          search: {
                            environment: row.environmentId,
                            schedule: row.id,
                            tab: "overview",
                          },
                        });
                        if (isMobile) setOpenMobile(false);
                      }}
                    />
                  ))}
              </section>
            );
          })}
          {isReady && !filtered.length && environments.some((e) => e.hasSnapshot) && (
            <div className="space-y-3 px-3 py-8 text-sm">
              <CalendarClockIcon className="size-6 text-muted-foreground" />
              <p>{rows.length ? "No matching schedules" : "No schedules yet"}</p>
              <p className="text-muted-foreground">
                {rows.length
                  ? "Try another search or clear your filters."
                  : "Run a prompt once or on a recurring schedule."}
              </p>
              {count > 0 && (
                <Button variant="outline" size="sm" onClick={clear}>
                  Clear filters
                </Button>
              )}
            </div>
          )}
        </div>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

function FilterGroup({
  label,
  selected,
  options,
  onToggle,
  onClear,
  searchable = false,
}: {
  label: string;
  selected: readonly string[];
  options: { value: string; label: string; detail?: string }[];
  onToggle: (v: string) => void;
  onClear: () => void;
  searchable?: boolean;
}) {
  const [query, setQuery] = useState("");
  return (
    <MenuSub>
      <MenuSubTrigger>
        {label}
        <span className="ml-auto text-xs text-muted-foreground">{selected.length || ""}</span>
      </MenuSubTrigger>
      <MenuSubPopup className="w-72">
        {searchable && (
          <input
            aria-label={`Search ${label.toLowerCase()}`}
            placeholder={`Search ${label.toLowerCase()}…`}
            className="h-9 w-full border-b bg-transparent px-2 text-sm outline-none"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        )}
        {options
          .filter((o) => `${o.label} ${o.detail ?? ""}`.toLowerCase().includes(query.toLowerCase()))
          .map((o) => (
            <MenuCheckboxItem
              key={o.value}
              checked={
                selected.includes(o.value) ||
                (label === "Failures" && !selected.length && o.value === "all")
              }
              onCheckedChange={() => onToggle(o.value)}
              closeOnClick={false}
            >
              <span className="flex flex-col py-1">
                <span>{o.label}</span>
                {o.detail && <span className="text-xs text-muted-foreground">{o.detail}</span>}
              </span>
            </MenuCheckboxItem>
          ))}
        <MenuItem onClick={onClear}>Clear {label.toLowerCase()}</MenuItem>
      </MenuSubPopup>
    </MenuSub>
  );
}

function ScheduleSidebarRow({
  row,
  project,
  selected,
  onSelect,
}: {
  row: AggregatedScheduleRow;
  project: ReturnType<typeof useProjects>[number] | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const [preview, setPreview] = useState(false);
  const detail = useEnvironmentQuery(
    preview
      ? scheduleEnvironment.detail({
          environmentId: row.environmentId,
          input: { scheduleId: ScheduleId.make(row.id), revision: row.revision },
        })
      : null,
  );
  const Icon = row.online ? stateIcons[row.state] : WifiOffIcon;
  const nextAt =
    row.nextOccurrenceAt ??
    (row.state === "failed" && row.latestHistory?.type === "failed"
      ? row.latestHistory.scheduledFor
      : null);
  const next = nextAt ? new Date(nextAt) : null;
  return (
    <div
      className={cn(
        "group/schedule relative rounded-lg border border-transparent",
        selected ? "border-sidebar-border bg-background" : "hover:bg-sidebar-accent",
      )}
    >
      <Tooltip open={preview} onOpenChange={setPreview}>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={onSelect}
              aria-current={selected ? "page" : undefined}
              className="flex min-h-[82px] w-full items-center gap-2.5 rounded-lg px-2 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <span
            className={cn(
              "relative mx-px flex size-[30px] shrink-0 items-center justify-center rounded-full border bg-background",
              row.state === "failed" && "border-destructive",
              !row.online && "opacity-45",
            )}
          >
            {project ? (
              <ProjectFavicon
                project={project}
                className="size-4"
              />
            ) : (
              <CalendarClockIcon className="size-[18px]" />
            )}
            <Icon className="absolute -right-[3px] -bottom-[3px] size-3.5 rounded-full border bg-sidebar p-0.5 text-muted-foreground" />
          </span>
          <span className="min-w-0 flex-1 space-y-0.5">
            <span
              className={cn(
                "block truncate text-sm font-medium",
                (row.state === "paused" || row.state === "completed" || !row.online) &&
                  "text-muted-foreground",
              )}
            >
              {row.name}
            </span>
            <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <EnvironmentIcon environmentId={row.environmentId} className="size-[18px] shrink-0" />
              <span className="truncate">
                {project?.title ?? "Missing project"} · {row.environmentLabel}
              </span>
            </span>
            <span
              className={cn(
                "flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground",
                row.state === "failed" && "text-destructive",
              )}
            >
              {row.online && row.state === "enabled" ? (
                <RepeatIcon className="size-3 shrink-0" />
              ) : (
                <Icon className="size-3 shrink-0" />
              )}
              <span className="truncate">
                {!row.online
                  ? `${title(row.state)} · Cached schedule`
                  : row.state === "failed"
                    ? row.latestHistory?.type === "failed"
                      ? `Failed · ${row.latestHistory.count} ${row.latestHistory.count === 1 ? "attempt" : "attempts"}`
                      : "Failed trigger"
                    : describeScheduleCadence(row.timing, row.timeZone)}
              </span>
            </span>
          </span>
          <span className="flex w-[46px] shrink-0 self-stretch flex-col items-end text-right text-[11px] leading-4 text-muted-foreground">
            <span>
              {!row.online
                ? "Offline"
                : row.state === "paused"
                  ? "Paused"
                  : row.state === "completed"
                    ? "Done"
                    : next
                      ? new Intl.DateTimeFormat("en-CA", { timeZone: row.timeZone }).format(
                          next,
                        ) ===
                          new Intl.DateTimeFormat("en-CA", { timeZone: row.timeZone }).format(
                            new Date(),
                          ) && row.state === "failed"
                        ? "Today"
                        : new Intl.DateTimeFormat(undefined, {
                            weekday: "short",
                            timeZone: row.timeZone,
                          }).format(next)
                      : "—"}
            </span>
            {row.online && next && (
              <span>
                {new Intl.DateTimeFormat(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                  hourCycle: "h23",
                  timeZone: row.timeZone,
                }).format(next)}
              </span>
            )}
            {row.unacknowledgedFailure && (
              <span
                aria-label="Unacknowledged failure"
                className="mt-auto size-1 rounded-full bg-destructive"
              />
            )}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="right" className="w-80 space-y-3 p-5">
          <p className="font-medium">{row.name}</p>
          <p className="text-xs text-muted-foreground">
            {project?.title ?? "Missing project"} · {row.environmentLabel} · {title(row.state)}
          </p>
          <p className="line-clamp-5 whitespace-pre-wrap text-sm">
            {detail.data?.prompt ?? detail.error ?? "Loading prompt…"}
          </p>
          <p className="text-xs text-muted-foreground">
            {describeScheduleCadence(row.timing, row.timeZone)} · {row.timeZone}
          </p>
        </TooltipPopup>
      </Tooltip>
      <div className="schedule-row-actions absolute right-1 bottom-1 hidden group-hover/schedule:block group-focus-within/schedule:block">
        <ScheduleActions row={row} compact />
      </div>
    </div>
  );
}
