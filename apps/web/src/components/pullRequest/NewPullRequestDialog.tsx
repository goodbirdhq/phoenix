import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { useProjects } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useComposerDraftStore } from "~/composerDraftStore";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";

/** Creation uses the thread's existing Git workflow; opening this dialog never publishes a PR. */
export function NewPullRequestDialog({
  environmentId,
  projectId,
}: {
  environmentId?: EnvironmentId;
  projectId?: ProjectId;
}) {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const newThread = useNewThreadHandler();
  const [open, setOpen] = useState(false);
  const [projectKey, setProjectKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyOf = (project: (typeof projects)[number]) =>
    JSON.stringify([project.environmentId, project.id]);
  const available = projects.filter((project) =>
    environments.some(
      (environment) =>
        environment.environmentId === project.environmentId &&
        environment.connection.phase === "connected",
    ),
  );
  const selected = available.find((project) => keyOf(project) === projectKey);
  const start = async () => {
    if (!selected || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await newThread(scopeProjectRef(selected.environmentId, selected.id));
      if (!result) {
        setError("Could not open a thread. Select a connected project and try again.");
        return;
      }
      const store = useComposerDraftStore.getState();
      const previous = store.getComposerDraft(result.draftId)?.prompt ?? "";
      store.setPrompt(
        result.draftId,
        [
          previous,
          "Help me prepare a pull request for this project. Review the changes and draft a title and description before publishing.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      setOpen(false);
    } catch {
      setError("Could not open a thread. Your selection is retained. Try again.");
    } finally {
      setPending(false);
    }
  };
  return (
    <>
      <Button
        variant="default"
        size="icon-sm"
        aria-label="New pull request"
        onClick={() => {
          const initial =
            available.find(
              (project) => project.environmentId === environmentId && project.id === projectId,
            ) ??
            available.find((project) => project.environmentId === environmentId) ??
            available[0];
          setProjectKey(initial ? keyOf(initial) : "");
          setError(null);
          setOpen(true);
        }}
      >
        <PlusIcon className="size-[18px]" />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!pending) setOpen(next);
        }}
      >
        <DialogPopup showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>New pull request</DialogTitle>
            <DialogDescription>
              Choose a project to prepare the pull request in a thread. Review the changes there,
              then use the thread’s Git actions to publish.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 px-6 pb-6">
            <label className="block space-y-2 text-sm">
              <span>Project and environment</span>
              <select
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
                disabled={pending}
                value={projectKey}
                onChange={(event) => setProjectKey(event.target.value)}
              >
                {available.length === 0 ? (
                  <option value="">No connected projects</option>
                ) : (
                  available.map((project) => (
                    <option key={keyOf(project)} value={keyOf(project)}>
                      {project.title} ·{" "}
                      {environments.find(
                        (environment) => environment.environmentId === project.environmentId,
                      )?.label ?? "Environment"}
                    </option>
                  ))
                )}
              </select>
            </label>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!selected || pending} onClick={() => void start()}>
              {pending ? "Opening…" : "Continue in thread"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
