import { api } from "@/lib/convex-api";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { useCallback } from "react";

import WorkHistoryReplay from "@/components/work-history-replay";
import IntegritySignalReview from "@/components/integrity-signal-review";
import { useTeacherPresence } from "@/components/use-teacher-presence";

export const Route = createFileRoute("/_auth/work-history/$workspaceId")({
  component: WorkHistoryRoute,
});

function WorkHistoryRoute() {
  const { workspaceId } = Route.useParams();
  const description = useQuery(api.workHistoryReplay.describe, { workspaceId });
  const readNext = useAction(api.workHistoryReplayRead.readNext);
  const inspectSignal = useAction(api.integritySignalEvidence.inspect);
  const reviewSignal = useMutation(api.integritySignals.review);
  const signals = useQuery(
    api.integritySignals.listForWorkspace,
    description?.viewerRole === "teacher" ? { workspaceId } : "skip",
  );
  const presence = useTeacherPresence(
    workspaceId,
    "work_history",
    description?.viewerRole === "teacher",
  );
  const loadPage = useCallback(
    async (afterSequence: number) => (await readNext({ workspaceId, afterSequence })) ?? undefined,
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
          {description.viewerRole === "teacher" && presence.error ? (
            <p className="mt-1 text-sm text-destructive">{presence.error}</p>
          ) : null}
        </header>
        <WorkHistoryReplay committedThrough={description.committedThrough} loadPage={loadPage} />
        {description.viewerRole === "teacher" ? (
          signals ? (
            <IntegritySignalReview
              signals={signals}
              inspect={async (signalId) => await inspectSignal({ signalId })}
              review={async (signalId, state, note) => {
                await reviewSignal({ signalId, state, note });
              }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Loading Integrity Signals…</p>
          )
        ) : null}
      </div>
    </main>
  );
}
