import { createFileRoute, Link } from "@tanstack/react-router";

import LiveWorkspaceViewer from "@/components/live-workspace-viewer";

export const Route = createFileRoute("/_auth/workspaces/$workspaceId/live")({
  component: LiveWorkspaceRoute,
});

function LiveWorkspaceRoute() {
  const { workspaceId } = Route.useParams();
  return (
    <main className="isolate min-h-0 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-5">
        <Link to="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
          ← Dashboard
        </Link>
        <LiveWorkspaceViewer workspaceId={workspaceId} key={workspaceId} />
      </div>
    </main>
  );
}
