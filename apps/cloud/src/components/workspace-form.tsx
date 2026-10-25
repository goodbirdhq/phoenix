import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useAppForm } from "~/lib/form";
import { workspaceInput } from "~/lib/validation";
import { createWorkspace, renameWorkspace } from "~/server/functions";
import { Button } from "~/components/ui/button";

export function WorkspaceForm({
  workspace,
  onDone,
}: {
  workspace?: { id: string; name: string };
  onDone: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const form = useAppForm({
    defaultValues: { name: workspace?.name ?? "" },
    validators: { onChange: workspaceInput },
    onSubmit: async ({ value }) => {
      setError("");
      try {
        if (workspace) await renameWorkspace({ data: { id: workspace.id, ...value } });
        else await createWorkspace({ data: value });
        await router.invalidate();
        onDone();
      } catch {
        setError("Couldn't save this workspace. Please try again.");
      }
    },
  });
  return (
    <form
      className="inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <form.AppField name="name">
        {(field) => (
          <field.TextField
            label="Workspace name"
            placeholder="e.g. My next big idea"
            required
            maxLength={80}
            autoFocus
          />
        )}
      </form.AppField>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(busy) => (
          <div className="form-actions">
            <Button type="button" variant="outline" onClick={onDone} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : workspace ? "Save name" : "Create workspace"}
            </Button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
}
