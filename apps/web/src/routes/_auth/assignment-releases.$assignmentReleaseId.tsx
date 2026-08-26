import { api } from "@enkode.app/backend/convex/_generated/api";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useState } from "react";

import WorkspaceEditor, {
  type RunResult,
  type SubmissionResult,
} from "@/components/workspace-editor";
import { WorkspaceViewers } from "@/components/live-workspace-viewer";
import type { StarterFileDecision, StarterFileMerge, WorkspaceFile } from "@/lib/workspace-state";
import type { WorkHistoryChunk } from "@/lib/work-history";

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
  version: number;
  effectiveDeadline: {
    deadlinePolicy: "no_deadline" | "accept_late" | "hard_close";
    deadlineAt?: number;
  };
  submissionEligibility: { canSubmit: boolean; reason?: string; remainingAttempts?: number };
  deadlineFacts: { missing: boolean; late: boolean };
};

type Workspace = {
  _id: string;
  files: WorkspaceFile[];
  runtimeVersion: string;
  entrypoint: string;
  version: number;
  versionMerge?: {
    mergeId: string;
    fromVersion: number;
    toVersion: number;
    fromAssignmentVersionId: string;
    toAssignmentVersionId: string;
    changedStarterFiles: StarterFileMerge[];
  };
};

type ReturnedGrade = {
  status: "awaiting_submission" | "awaiting_review" | "returned";
  returned: null | {
    points: number;
    proposedPoints: number;
    overallFeedback?: string;
    revision: number;
    returnedAt: number;
    inlineFeedback: {
      path: string;
      startLine: number;
      startColumn: number;
      endLine: number;
      endColumn: number;
      body: string;
    }[];
  };
};

function AssignmentWorkspaceRoute() {
  const { assignmentReleaseId } = Route.useParams();
  const release = useQuery(api.assignmentReleases.open, { assignmentReleaseId }) as
    | Release
    | undefined;
  const openWorkspace = useMutation(api.workspaces.open);
  const saveWorkspace = useMutation(api.workspaces.save);
  const completeVersionMerge = useMutation(api.workspaces.completeVersionMerge);
  const acceptHistoryChunk = useAction(api.workHistoryUpload.acceptChunk);
  const runWorkspace = useAction(api.runs.run);
  const submitWorkspace = useAction(api.submissionUpload.submit);
  const grade = useQuery(api.grades.mine, { assignmentReleaseId }) as ReturnedGrade | undefined;
  const [workspace, setWorkspace] = useState<Workspace>();
  const [error, setError] = useState<string>();
  const submissions = useQuery(
    api.submissions.mine,
    workspace ? { workspaceId: workspace._id } : "skip",
  ) as SubmissionResult[] | undefined;
  const uploadHistory = useCallback(
    async (chunk: WorkHistoryChunk) =>
      await acceptHistoryChunk({
        workspaceId: chunk.workspaceId,
        startSequence: chunk.startSequence,
        endSequence: chunk.endSequence,
        eventCount: chunk.eventCount,
        contentHash: chunk.contentHash,
        byteLength: chunk.byteLength,
        bytes: chunk.bytes,
        snapshotHash: chunk.snapshotHash,
        snapshotByteLength: chunk.snapshotByteLength,
        snapshotBytes: chunk.snapshotBytes,
      }),
    [acceptHistoryChunk],
  );

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
            Python {workspace.runtimeVersion} · Workspace Version {workspace.version}
            {workspace.versionMerge ? ` · Release Version ${release.version}` : ""} · Editing
            available
          </p>
        </header>
        <details className="border-y border-foreground/10 py-3">
          <summary className="cursor-pointer font-medium">Instructions</summary>
          <p className="mt-3 max-w-[75ch] whitespace-pre-wrap text-sm text-muted-foreground">
            {release.instructions}
          </p>
        </details>
        <WorkspaceViewers workspaceId={workspace._id} />
        <section className="flex flex-wrap gap-x-5 gap-y-1 border-y border-foreground/10 py-3 text-sm">
          <span>
            Deadline:{" "}
            {release.effectiveDeadline.deadlineAt === undefined
              ? "None"
              : new Date(release.effectiveDeadline.deadlineAt).toLocaleString([], {
                  timeZoneName: "short",
                })}
          </span>
          {release.submissionEligibility.remainingAttempts !== undefined ? (
            <span>{release.submissionEligibility.remainingAttempts} attempts remaining</span>
          ) : (
            <span>Unlimited attempts</span>
          )}
          {release.deadlineFacts.missing ? <span className="text-destructive">Missing</span> : null}
          {release.deadlineFacts.late ? <span>Late Submission recorded</span> : null}
        </section>
        <WorkspaceEditor
          assignmentReleaseId={assignmentReleaseId}
          workspaceId={workspace._id}
          files={workspace.files}
          entrypoint={workspace.entrypoint}
          runtimeVersion={workspace.runtimeVersion}
          versionMerge={workspace.versionMerge}
          onCompleteVersionMerge={async (
            mergeId: string,
            decisions: StarterFileDecision[],
            requiredHistorySequence: number,
          ) => {
            const updated = (await completeVersionMerge({
              mergeId,
              decisions,
              acknowledged: true,
              requiredHistorySequence,
            })) as Workspace;
            setWorkspace(updated);
          }}
          onUploadHistory={uploadHistory}
          onRun={async (files) =>
            (await runWorkspace({ workspaceId: workspace._id, files })) as RunResult
          }
          submissions={submissions ?? []}
          submissionEligibility={release.submissionEligibility}
          onSubmit={async (files, requiredHistorySequence, idempotencyKey) =>
            (await submitWorkspace({
              workspaceId: workspace._id,
              files,
              requiredHistorySequence,
              idempotencyKey,
            })) as SubmissionResult
          }
          onSave={async (files) => {
            await saveWorkspace({ workspaceId: workspace._id, files });
            setWorkspace((current) => (current ? { ...current, files } : current));
          }}
        />
        {grade ? <ReturnedGradeSummary grade={grade} /> : null}
        <p className="text-xs text-muted-foreground">
          Save stores your Workspace. Running and submitting are separate actions and are never
          triggered by saving.
        </p>
        <Link
          to="/work-history/$workspaceId"
          params={{ workspaceId: workspace._id }}
          className="self-start text-sm font-medium underline-offset-4 hover:underline"
        >
          Open Work History
        </Link>
      </div>
    </main>
  );
}

function ReturnedGradeSummary({ grade }: { grade: ReturnedGrade }) {
  return (
    <section className="border-y border-foreground/10 py-4" aria-label="Grade and Feedback">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">Grade and Feedback</h2>
        <p className="text-sm capitalize text-muted-foreground">{grade.status.replace("_", " ")}</p>
      </div>
      {!grade.returned ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Your teacher has not returned a Grade yet.
        </p>
      ) : (
        <div className="mt-3 grid gap-3">
          <p className="text-lg font-semibold tabular-nums">{grade.returned.points} points</p>
          {grade.status === "awaiting_review" ? (
            <p className="text-sm text-muted-foreground">
              This is your currently returned Grade. Your newer Submission is awaiting review.
            </p>
          ) : null}
          {grade.returned.overallFeedback ? (
            <p className="whitespace-pre-wrap text-sm">{grade.returned.overallFeedback}</p>
          ) : null}
          {grade.returned.inlineFeedback.length > 0 ? (
            <ul className="grid gap-2">
              {grade.returned.inlineFeedback.map((feedback, index) => (
                <li className="border border-foreground/10 p-3 text-sm" key={index}>
                  <p className="font-mono text-xs text-muted-foreground">
                    {feedback.path}:{feedback.startLine}:{feedback.startColumn}–{feedback.endLine}:
                    {feedback.endColumn}
                  </p>
                  <p className="mt-1">{feedback.body}</p>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Revision {grade.returned.revision} · Returned{" "}
            {new Date(grade.returned.returnedAt).toLocaleString()}
          </p>
        </div>
      )}
    </section>
  );
}
