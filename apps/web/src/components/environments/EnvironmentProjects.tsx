import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ArrowRightIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useProjects, useThreadShells } from "../../state/entities";
import { useSettingsProjectGroups } from "../settings/ProjectSettingsPanel";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useEnvironmentSessionState } from "../../state/session";
import { openCommandPalette } from "../../commandPaletteBus";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table";
import { Button } from "../ui/button";

export function EnvironmentProjects({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const threads = useThreadShells();
  const groups = useSettingsProjectGroups();
  const open = useNewThreadHandler();
  const session = useEnvironmentSessionState(environmentId);
  const canEdit = session.data?.scopes?.includes("orchestration:operate") ?? false;
  const [search, setSearch] = useState("");
  const visible = projects.filter((p) =>
    `${p.title} ${p.workspaceRoot}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const counts = new Map<string, number>();
  for (const thread of threads)
    if (thread.environmentId === environmentId)
      counts.set(thread.projectId, (counts.get(thread.projectId) ?? 0) + 1);
  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base leading-[22px] font-semibold">Projects on {label}</h2>
          <p className="mt-1 text-xs leading-[18px] text-muted-foreground">
            {projects.length} {projects.length === 1 ? "project" : "projects"} · Workspaces
            registered on this environment
          </p>
        </div>
        <Button
          data-environment-control
          size="sm"
          className="h-9 sm:h-9 px-3 text-[13px] sm:text-[13px]"
          disabled={!canEdit}
          onClick={() => openCommandPalette({ open: "add-project", environmentId })}
        >
          Add project
        </Button>
      </div>
      <div className="space-y-3">
        <label className="flex h-[42px] items-center rounded-lg border px-3 text-muted-foreground">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search projects"
            placeholder="Search projects…"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <Table className="environment-table">
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead className="w-20 text-right">Threads</TableHead>
              <TableHead className="w-[296px]">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((p) => {
              const group = groups.find((g) =>
                g.memberProjects.some((m) => m.environmentId === environmentId && m.id === p.id),
              );
              return (
                <TableRow key={p.id}>
                  <TableCell>
                    <p className="text-[13px] font-medium">{p.title}</p>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <p
                            tabIndex={0}
                            className="mt-1 max-w-[32rem] truncate text-xs text-muted-foreground"
                          />
                        }
                      >
                        {p.workspaceRoot}
                      </TooltipTrigger>
                      <TooltipPopup>{p.workspaceRoot}</TooltipPopup>
                    </Tooltip>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{counts.get(p.id) ?? 0}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-between gap-5 px-6">
                      <Button
                        data-environment-control
                        data-environment-action
                        size="sm"
                        variant="ghost"
                        disabled={!canEdit}
                        onClick={() => void open(scopeProjectRef(environmentId, p.id))}
                      >
                        Open
                        <ArrowRightIcon className="size-3.5" />
                      </Button>
                      {group && (
                        <Link
                          to="/projects/$projectKey"
                          params={{ projectKey: group.projectKey }}
                          aria-label={`Settings for ${p.title}`}
                          className="rounded-sm text-[13px] text-sky-600 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Project settings
                        </Link>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {!visible.length && (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-muted-foreground">
                  {projects.length
                    ? "No projects match your search."
                    : "No projects on this environment yet."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
