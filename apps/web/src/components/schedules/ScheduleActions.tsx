import { OccurrenceId, ScheduleId } from "@t3tools/contracts";
import type { AggregatedScheduleRow } from "@t3tools/client-runtime/schedules";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  MoreHorizontalIcon,
  ChevronDownIcon,
  PauseIcon,
  PlayIcon,
  PencilIcon,
  CopyIcon,
  Trash2Icon,
} from "lucide-react";
import { useRef, useState } from "react";
import { useEnvironmentSessionState } from "../../state/session";
import { scheduleEnvironment } from "../../state/schedules";
import { useAtomCommand } from "../../state/use-atom-command";
import { newCommandId, randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "../ui/menu";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "../ui/alert-dialog";
import { toastManager } from "../ui/toast";

export function useSchedulePermission(
  row: Pick<AggregatedScheduleRow, "environmentId" | "online" | "supportsSchedules">,
) {
  const session = useEnvironmentSessionState(row.environmentId);
  const reason = !row.online
    ? "Connect to this environment to make changes."
    : !row.supportsSchedules
      ? "Update this environment to manage schedules."
      : !session.data
        ? "Checking schedule permissions…"
        : !session.data.scopes?.includes("orchestration:operate")
          ? "This connection is read only. Operate tasks permission is required."
          : null;
  return { allowed: reason === null, reason };
}

export function ScheduleActions({
  row,
  compact = false,
  lifecycleOnly = false,
}: {
  row: AggregatedScheduleRow;
  compact?: boolean;
  lifecycleOnly?: boolean;
}) {
  const permission = useSchedulePermission(row);
  const dispatch = useAtomCommand(scheduleEnvironment.dispatch);
  const navigate = useNavigate();
  const route = useSearch({ from: "/schedules" });
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutate = async (
    type: "schedule.run-now" | "schedule.pause" | "schedule.resume" | "schedule.delete",
  ) => {
    if (locked.current || !permission.allowed) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await dispatch({
        environmentId: row.environmentId,
        input: {
          commandId: newCommandId(),
          scheduleId: ScheduleId.make(row.id),
          ...(type === "schedule.run-now"
            ? { type, occurrenceId: OccurrenceId.make(randomUUID()) }
            : { type }),
        },
      });
      if (result._tag === "Failure")
        throw new Error(
          "The environment could not apply this change. Check the connection and try again.",
        );
      if (type === "schedule.delete") {
        setDeleting(false);
        if (
          !route.schedule ||
          (route.schedule === row.id && route.environment === row.environmentId)
        )
          await navigate({ to: "/schedules", search: {} });
      }
      toastManager.add({
        type: "success",
        title:
          type === "schedule.run-now"
            ? "Run requested"
            : type === "schedule.pause"
              ? "Schedule paused"
              : type === "schedule.resume"
                ? "Schedule resumed"
                : "Schedule deleted",
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Schedule change failed. Try again.";
      setError(message);
      if (type !== "schedule.delete")
        toastManager.add({ type: "error", title: "Schedule change failed", description: message });
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const openEditor = (duplicate: boolean) =>
    void navigate({
      to: "/schedules",
      search: {
        environment: row.environmentId,
        schedule: row.id,
        tab: route.tab ?? "overview",
        ...(duplicate ? { duplicate: true } : { edit: true }),
      },
    });
  if (lifecycleOnly)
    return row.state === "enabled" || row.state === "paused" ? (
      <Button
        variant="outline"
        className="schedule-control"
        disabled={busy || !permission.allowed}
        onClick={() => void mutate(row.state === "paused" ? "schedule.resume" : "schedule.pause")}
      >
        {row.state === "paused" ? "Resume schedule" : "Pause schedule"}
      </Button>
    ) : (
      <div className="flex items-center gap-5">
        {row.state === "failed" && (
          <Button
            variant="outline"
            className="schedule-control"
            disabled={busy || !permission.allowed}
            onClick={() => void mutate("schedule.run-now")}
          >
            Run now
          </Button>
        )}
        <Button
          variant="outline"
          className="schedule-control"
          disabled={busy || !permission.allowed}
          onClick={() => openEditor(false)}
        >
          Edit schedule
        </Button>
      </div>
    );
  return (
    <>
      <div
        className={
          compact ? "flex shrink-0 items-center gap-2" : "flex shrink-0 items-center gap-3"
        }
      >
        <Button
          variant="outline"
          size={compact ? "icon" : "default"}
          className={compact ? "size-6 border-0 bg-transparent shadow-none" : "schedule-control"}
          aria-label={`Run ${row.name} now`}
          disabled={busy || !permission.allowed}
          onClick={() => void mutate("schedule.run-now")}
        >
          {compact ? <PlayIcon className="size-4" /> : "Run now"}
        </Button>
        {!compact && (
          <Button
            variant="outline"
            className="schedule-control"
            disabled={busy || !permission.allowed}
            onClick={() => openEditor(false)}
          >
            Edit schedule
          </Button>
        )}
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="outline"
                size={compact ? "icon" : "default"}
                className={
                  compact ? "size-6 border-0 bg-transparent shadow-none" : "schedule-control gap-1"
                }
                aria-label={`More actions for ${row.name}`}
              />
            }
          >
            {compact ? (
              <MoreHorizontalIcon className="size-4" />
            ) : (
              <>
                More <ChevronDownIcon className="size-2.5" />
              </>
            )}
          </MenuTrigger>
          <MenuPopup align="end" className="w-56">
            <MenuItem
              disabled={busy || !permission.allowed}
              onClick={() => void mutate("schedule.run-now")}
            >
              <PlayIcon />
              Run now
            </MenuItem>
            {(row.state === "enabled" || row.state === "paused") && (
              <MenuItem
                disabled={busy || !permission.allowed}
                onClick={() =>
                  void mutate(row.state === "paused" ? "schedule.resume" : "schedule.pause")
                }
              >
                {row.state === "paused" ? <PlayIcon /> : <PauseIcon />}
                {row.state === "paused" ? "Resume schedule" : "Pause schedule"}
              </MenuItem>
            )}
            <MenuItem disabled={busy || !permission.allowed} onClick={() => openEditor(false)}>
              <PencilIcon />
              Edit schedule…
            </MenuItem>
            <MenuItem disabled={busy || !row.online} onClick={() => openEditor(true)}>
              <CopyIcon />
              Duplicate…
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              disabled={busy || !permission.allowed}
              onClick={() => {
                setError(null);
                setDeleting(true);
              }}
            >
              <Trash2Icon />
              Delete schedule…
            </MenuItem>
            {permission.reason && (
              <p className="px-2 py-2 text-xs text-muted-foreground">{permission.reason}</p>
            )}
          </MenuPopup>
        </Menu>
      </div>
      <AlertDialog
        open={deleting}
        onOpenChange={(open) => {
          if (!busy) setDeleting(open);
        }}
      >
        <AlertDialogPopup className="schedule-surface schedule-delete rounded-[14px] sm:max-w-[430px]">
          <AlertDialogHeader>
            <span className="mb-3 flex size-[38px] items-center justify-center rounded-lg bg-destructive/5 text-destructive">
              <Trash2Icon className="size-4" />
            </span>
            <AlertDialogTitle>Delete schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              “{row.name}” and its schedule history will be deleted. Existing threads and worktrees
              will remain. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="px-6 text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter variant="bare">
            <Button autoFocus variant="outline" disabled={busy} onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !permission.allowed}
              onClick={() => void mutate("schedule.delete")}
            >
              {busy ? "Deleting…" : "Delete schedule"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
