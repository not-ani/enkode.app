import { api } from "@enkode.app/backend/convex/_generated/api";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";

import { GradeEditor } from "@/components/grading";
import { assignmentStatusLabel, type GradebookData } from "@/lib/gradebook";

export const Route = createFileRoute(
  "/_auth/gradebook/$classroomId/$assignmentReleaseId/$studentId",
)({ component: GradebookCellRoute });

function GradebookCellRoute() {
  const { classroomId, assignmentReleaseId, studentId } = Route.useParams();
  const gradebook = useQuery(api.gradebook.forClassroom, { classroomId }) as
    | GradebookData
    | undefined;
  if (!gradebook) {
    return <main className="p-6 text-sm text-muted-foreground">Opening Gradebook cell…</main>;
  }
  const release = gradebook.releases.find(({ id }) => id === assignmentReleaseId);
  const student = gradebook.students.find(({ id }) => id === studentId);
  const cell = student?.cells.find(
    ({ assignmentReleaseId: cellReleaseId }) => cellReleaseId === assignmentReleaseId,
  );
  if (!release || !student || !cell) {
    return <main className="p-6 text-sm text-muted-foreground">Gradebook cell not found.</main>;
  }
  const hasSubmission =
    cell.status === "submitted" || cell.status === "awaiting_review" || cell.status === "returned";

  return (
    <main className="isolate overflow-y-auto py-8 sm:py-10">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-5 sm:px-8">
        <header className="flex flex-col gap-2">
          <Link
            to="/dashboard"
            className="self-start text-sm text-muted-foreground hover:text-foreground"
          >
            ← Gradebook
          </Link>
          <p className="mt-2 text-sm text-muted-foreground">
            {gradebook.classroom.name} · {gradebook.classroom.courseName}
          </p>
          <h1 className="text-balance text-2xl font-semibold tracking-tight">
            {student.displayName} · {release.assignmentTitle}
          </h1>
          <p className="text-sm text-muted-foreground">
            @{student.username} · {assignmentStatusLabel[cell.status]} ·{" "}
            {cell.points === undefined
              ? "No points yet"
              : `${cell.points} / ${release.points} points`}
            {cell.deadlineFacts.missing ? " · Missing" : ""}
            {cell.deadlineFacts.late ? " · Late" : ""}
          </p>
        </header>
        {hasSubmission ? (
          <GradeEditor
            row={{
              assignmentReleaseId,
              assignmentTitle: release.assignmentTitle,
              studentId,
              studentName: student.displayName,
              attemptCount: 0,
              status: cell.status,
            }}
          />
        ) : (
          <p className="border-y border-foreground/10 py-5 text-sm text-muted-foreground">
            {cell.status === "excused"
              ? "This ended Enrollment has no academic record for this Assignment Release."
              : "This Student has not submitted this Assignment Release yet."}
          </p>
        )}
      </div>
    </main>
  );
}
