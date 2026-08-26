import { api } from "@enkode.app/backend/convex/_generated/api";
import { Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";

type LiveWorkspaceSummary = {
  workspaceId: string;
  assignmentTitle: string;
  classroomName: string;
  studentDisplayName: string;
  studentUsername: string;
  updatedAt: number;
};

export default function LiveWorkspaces() {
  const workspaces = useQuery(api.liveWorkspaces.listForTeacher) as
    | LiveWorkspaceSummary[]
    | undefined;

  return (
    <section className="flex max-w-2xl flex-col gap-3">
      <div>
        <h2 className="text-xl font-semibold">Student Workspaces</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          View committed work from actively enrolled Students in your Classrooms.
        </p>
      </div>
      {!workspaces ? (
        <p className="text-sm text-muted-foreground">Loading Workspaces…</p>
      ) : workspaces.length === 0 ? (
        <p className="border-t border-foreground/10 pt-4 text-sm text-muted-foreground">
          No Students have opened a Workspace yet.
        </p>
      ) : (
        <ul className="divide-y divide-foreground/10 border-y border-foreground/10">
          {workspaces.map((workspace) => (
            <li className="py-4" key={workspace.workspaceId}>
              <Link
                to="/workspaces/$workspaceId/live"
                params={{ workspaceId: workspace.workspaceId }}
                className="block hover:text-primary"
              >
                <span className="block font-medium">
                  {workspace.studentDisplayName} · {workspace.assignmentTitle}
                </span>
                <span className="block text-sm text-muted-foreground">
                  {workspace.classroomName} · @{workspace.studentUsername}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
