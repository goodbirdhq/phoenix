import { memo, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { CornerUpLeftIcon } from "lucide-react";
import { useThreadShell } from "../../state/entities";

/**
 * Small unobtrusive affordance shown on threads spawned by another thread's
 * agent session. Resolves the parent's title from the shell snapshot state
 * already held for the environment; falls back to a generic label when the
 * parent isn't (or is no longer) in that snapshot.
 */
export const SpawnedByBanner = memo(function SpawnedByBanner({
  environmentId,
  spawnedByThreadId,
}: {
  environmentId: EnvironmentId;
  spawnedByThreadId: ThreadId | null | undefined;
}) {
  const navigate = useNavigate();
  const parentThreadRef = useMemo(
    () => (spawnedByThreadId ? scopeThreadRef(environmentId, spawnedByThreadId) : null),
    [environmentId, spawnedByThreadId],
  );
  const parentShell = useThreadShell(parentThreadRef);

  if (!spawnedByThreadId) {
    return null;
  }

  const parentTitle = parentShell?.title ?? "another session";

  return (
    <div className="mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <button
        type="button"
        onClick={() =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: spawnedByThreadId },
          })
        }
        className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-border/60 bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        <CornerUpLeftIcon aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 truncate">
          Spawned by <span className="font-medium text-foreground">{parentTitle}</span>
        </span>
      </button>
    </div>
  );
});
