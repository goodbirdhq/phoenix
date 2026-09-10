import type { EnvironmentId, PullRequestDetailView, PullRequestRef } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EyeIcon, PencilIcon } from "lucide-react";
import { useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "../ui/alert-dialog";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { readableFailure } from "./pullRequestDetail.logic";
import { usePullRequestEditDrafts } from "./pullRequestEditDrafts";

export function PullRequestEditDialog({
  environmentId,
  reference,
  detail,
  open,
  onOpenChange,
  onSaved,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const key = JSON.stringify([
    environmentId,
    reference.projectId,
    reference.repository,
    reference.number,
  ]);
  const stored = usePullRequestEditDrafts((state) => state.drafts[key]);
  const draft = stored ?? { title: detail.title, body: detail.body };
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const update = useAtomCommand(pullRequestEnvironment.update, { reportFailure: false });
  const dirty = draft.title !== detail.title || draft.body !== detail.body;
  const close = () => {
    if (saving) return;
    if (dirty) setDiscardOpen(true);
    else {
      usePullRequestEditDrafts.getState().discard(key, draft);
      onOpenChange(false);
    }
  };
  const save = async () => {
    if (saving || !draft.title.trim()) return;
    setSaving(true);
    setError(null);
    const result = await update({
      environmentId,
      input: { ...reference, title: draft.title.trim(), body: draft.body },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      setError(
        readableFailure(
          squashAtomCommandFailure(result),
          "Couldn’t save changes. Your draft is intact. Try again.",
        ),
      );
      return;
    }
    usePullRequestEditDrafts.getState().discard(key, draft);
    onSaved();
    onOpenChange(false);
  };
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogPopup
          className="flex max-h-[calc(100dvh-48px)] max-w-2xl flex-col"
          showCloseButton={!saving}
        >
          <DialogHeader>
            <DialogTitle>Edit pull request</DialogTitle>
            <DialogDescription>
              {detail.repository} #{detail.number}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-6">
            <label className="block space-y-2 text-xs font-medium">
              <span>Title</span>
              <Input
                value={draft.title}
                disabled={saving}
                onChange={(event) =>
                  usePullRequestEditDrafts
                    .getState()
                    .save(key, { ...draft, title: event.target.value }, detail)
                }
              />
            </label>
            <div className="flex gap-6 border-b border-border" aria-label="Description editor">
              {[
                { label: "Write", value: false, Icon: PencilIcon },
                { label: "Preview", value: true, Icon: EyeIcon },
              ].map(({ label, value, Icon }) => (
                <Button
                  key={label}
                  variant="ghost"
                  aria-pressed={preview === value}
                  onClick={() => setPreview(value)}
                  className={`h-10 gap-2 rounded-none border-b-2 px-0 ${preview === value ? "border-foreground font-semibold" : "border-transparent text-muted-foreground"}`}
                >
                  <Icon className="size-4" />
                  {label}
                </Button>
              ))}
            </div>
            {preview ? (
              <div className="min-h-40 rounded-lg border border-border p-3">
                <PullRequestMarkdown
                  text={draft.body || "_Nothing to preview._"}
                  cwd={detail.workspaceRoot}
                  environmentId={environmentId}
                />
              </div>
            ) : (
              <Textarea
                aria-label="Pull request description"
                value={draft.body}
                disabled={saving}
                rows={8}
                onChange={(event) =>
                  usePullRequestEditDrafts
                    .getState()
                    .save(key, { ...draft, body: event.target.value }, detail)
                }
              />
            )}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={close}>
              Cancel
            </Button>
            <Button disabled={saving || !draft.title.trim()} onClick={() => void save()}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your unsaved title and description will be discarded. The published pull request will
              stay as it is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep editing</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                usePullRequestEditDrafts.getState().discard(key);
                setDiscardOpen(false);
                onOpenChange(false);
              }}
            >
              Discard changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
