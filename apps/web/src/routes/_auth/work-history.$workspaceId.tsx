import { api } from "@enkode.app/backend/convex/_generated/api";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useAction, useQuery } from "convex/react";
import { useCallback } from "react";

import WorkHistoryReplay, { type ReplayPage } from "@/components/work-history-replay";

export const Route = createFileRoute("/_auth/work-history/$workspaceId")({
  component: WorkHistoryRoute,
});

type Description = {
  assignmentTitle: string;
  classroomName: string;
  studentName: string;
  studentUsername: string;
  committedThrough: number;
  viewerRole: "student" | "teacher";
};

function WorkHistoryRoute() {
  const { workspaceId } = Route.useParams();
  const description = useQuery(api.workHistoryReplay.describe, { workspaceId }) as
    | Description
    | undefined;
  const readNext = useAction(api.workHistoryReplayRead.readNext);
  const loadPage = useCallback(
    async (afterSequence: number) =>
      (await readNext({ workspaceId, afterSequence })) as ReplayPage | undefined,
    [readNext, workspaceId],
  );

  if (!description) {
    return <main className="p-6 text-sm text-muted-foreground">Opening Work History…</main>;
  }

  return (
    <main className="isolate min-h-0 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <header>
          <Link to="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">
            ← Dashboard
          </Link>
          <p className="mt-3 text-sm text-muted-foreground">
            {description.classroomName}
            {description.viewerRole === "teacher"
              ? ` · ${description.studentName} (@${description.studentUsername})`
              : ""}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            {description.assignmentTitle} Work History
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A read-only replay of committed Workspace states.
          </p>
        </header>
        <WorkHistoryReplay committedThrough={description.committedThrough} loadPage={loadPage} />
      </div>
    </main>
  );
}
