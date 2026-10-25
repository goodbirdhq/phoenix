import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ArrowUpRight, Folder, Plus, Pencil, Trash2 } from "lucide-react";
import { deleteWorkspace, listWorkspaces } from "~/server/functions";
import { WorkspaceForm } from "~/components/workspace-form";
import { DeleteDialog } from "~/components/delete-dialog";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "~/components/ui/empty";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";

export const Route = createFileRoute("/_account/dashboard")({
  loader: () => listWorkspaces(),
  component: Dashboard,
});
function Dashboard() {
  const workspaces = Route.useLoaderData();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  async function remove(id: string) {
    setBusy(true);
    setError("");
    try {
      await deleteWorkspace({ data: { id } });
      await router.invalidate();
      setDeleting(null);
    } catch {
      setError("Couldn't delete this workspace. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-topline">
        <span>YOUR PERSONAL SPACE</span>
        <span className="cloud-badge">
          Phoenix Cloud <ArrowUpRight size={12} />
        </span>
      </div>
      <header className="page-heading">
        <div>
          <h1>Workspaces</h1>
          <p>A little structure for your next big idea.</p>
        </div>
        <Button size="lg" onClick={() => setCreating(true)} disabled={creating}>
          <Plus /> New workspace
        </Button>
      </header>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {creating && (
        <section className="editor-card">
          <h2>Make room for something new</h2>
          <WorkspaceForm onDone={() => setCreating(false)} />
        </section>
      )}
      <div className="section-label">
        <span>ALL WORKSPACES</span>
        <span>
          {workspaces.length} {workspaces.length === 1 ? "workspace" : "workspaces"}
        </span>
      </div>
      {workspaces.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Folder />
            </EmptyMedia>
            <EmptyTitle>Your ideas deserve a workspace</EmptyTitle>
            <EmptyDescription>
              Create your first workspace to start organizing your work.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => setCreating(true)}>
              <Plus /> Create a workspace
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="workspace-grid">
          {workspaces.map((workspace) => (
            <Card key={workspace.id}>
              <CardContent>
                <div className="workspace-card-top">
                  <span className="folder-icon">
                    <Folder size={21} />
                  </span>
                  <span className="record-label">WORKSPACE</span>
                </div>
                {editing === workspace.id ? (
                  <WorkspaceForm workspace={workspace} onDone={() => setEditing(null)} />
                ) : (
                  <>
                    <h2 className="workspace-name">{workspace.name}</h2>
                    <p className="workspace-date">
                      Created{" "}
                      {new Date(workspace.createdAt).toLocaleDateString("en", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        timeZone: "UTC",
                      })}
                    </p>
                    <div className="workspace-actions">
                      <Button variant="ghost" size="sm" onClick={() => setEditing(workspace.id)}>
                        <Pencil /> Rename
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${workspace.name}`}
                        onClick={() => setDeleting(workspace.id)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </>
                )}
                <DeleteDialog
                  open={deleting === workspace.id}
                  busy={busy}
                  title={`Delete “${workspace.name}”?`}
                  description="This permanently deletes the workspace from your account."
                  onClose={() => setDeleting(null)}
                  onConfirm={() => void remove(workspace.id)}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <aside className="info-note">
        <Folder size={18} />
        <p>
          Bring your ideas together here. Connecting projects and agent sessions is coming later.
        </p>
      </aside>
    </>
  );
}
