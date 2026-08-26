import { api } from "@enkode.app/backend/convex/_generated/api";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";

import WorkspaceEditor from "@/components/workspace-editor";
import type { WorkspaceFile } from "@/lib/workspace-state";

export const Route = createFileRoute("/_auth/assignment-releases/$assignmentReleaseId")({
  component: AssignmentWorkspaceRoute,
});

type Release = {
  _id: string;
  assignmentTitle: string;
  classroomName: string;
  instructions: string;
  runtimeVersion: string;
  entrypoint: string;
};

type Workspace = {
  _id: string;
  files: WorkspaceFile[];
};

function AssignmentWorkspaceRoute() {
  const { assignmentReleaseId } = Route.useParams();
  const release = useQuery(api.assignmentReleases.open, { assignmentReleaseId }) as
    | Release
    | undefined;
  const openWorkspace = useMutation(api.workspaces.open);
  const saveWorkspace = useMutation(api.workspaces.save);
  const [workspace, setWorkspace] = useState<Workspace>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void openWorkspace({ assignmentReleaseId })
      .then((opened: Workspace) => {
        if (active) setWorkspace(opened);
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Could not open Workspace");
      });
    return () => {
      active = false;
    };
  }, [assignmentReleaseId, openWorkspace]);

  if (error) {
    return <main className="p-6 text-destructive">{error}</main>;
  }
  if (!release || !workspace) {
    return <main className="p-6 text-sm text-muted-foreground">Opening Workspace…</main>;
  }

  return (
    <main className="isolate min-h-0 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-5">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <Link to="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
              ← Dashboard
            </Link>
            <p className="mt-3 text-sm text-muted-foreground">{release.classroomName}</p>
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {release.assignmentTitle}
            </h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Python {release.runtimeVersion} · Editing available
          </p>
        </header>
        <details className="border-y border-foreground/10 py-3">
          <summary className="cursor-pointer font-medium">Instructions</summary>
          <p className="mt-3 max-w-[75ch] whitespace-pre-wrap text-sm text-muted-foreground">
            {release.instructions}
          </p>
        </details>
        <WorkspaceEditor
          assignmentReleaseId={assignmentReleaseId}
          workspaceId={workspace._id}
          files={workspace.files}
          entrypoint={release.entrypoint}
          runtimeVersion={release.runtimeVersion}
          onSave={async (files) => {
            await saveWorkspace({ workspaceId: workspace._id, files });
            setWorkspace((current) => (current ? { ...current, files } : current));
          }}
        />
        <p className="text-xs text-muted-foreground">
          Save stores your Workspace. Running and submitting are separate actions and are never
          triggered by saving.
        </p>
      </div>
    </main>
  );
}
