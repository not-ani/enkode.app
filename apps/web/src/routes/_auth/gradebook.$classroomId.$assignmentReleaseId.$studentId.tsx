import { api } from "@/lib/convex-api";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@enkode.app/ui/components/button";
import { Input } from "@enkode.app/ui/components/input";
import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";

import { GradeEditor } from "@/components/grading";
import { assignmentStatusLabel } from "@/lib/gradebook";
import { messageFrom } from "@/lib/error-message";

export const Route = createFileRoute(
  "/_auth/gradebook/$classroomId/$assignmentReleaseId/$studentId",
)({ component: GradebookCellRoute });

function GradebookCellRoute() {
  const { classroomId, assignmentReleaseId, studentId } = Route.useParams();
  const gradebook = useQuery(api.gradebook.forClassroom, { classroomId });
  const setExcuse = useMutation(api.gradebook.setExcuse);
  const clearExcuse = useMutation(api.gradebook.clearExcuse);
  const [excuseError, setExcuseError] = useState<string>();
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

  async function excuse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setExcuseError(undefined);
    try {
      await setExcuse({
        assignmentReleaseId,
        studentId,
        reason: String(new FormData(event.currentTarget).get("reason")),
      });
    } catch (error) {
      setExcuseError(messageFrom(error, "Could not excuse this Assignment"));
    }
  }

  async function clear() {
    setExcuseError(undefined);
    try {
      await clearExcuse({ assignmentReleaseId, studentId });
    } catch (error) {
      setExcuseError(messageFrom(error, "Could not clear this excuse"));
    }
  }

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
              ? `This Student is excused${cell.excuseReason ? `: ${cell.excuseReason}` : "."}`
              : "This Student has not submitted this Assignment Release yet."}
          </p>
        )}
        <section className="border-t border-foreground/10 pt-5">
          <h2 className="font-medium">Assignment excuse</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Excuses are explicit academic records and do not follow Enrollment access changes.
          </p>
          {cell.status === "excused" ? (
            <Button
              className="mt-3"
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void clear()}
            >
              Clear excuse
            </Button>
          ) : (
            <form className="mt-3 flex max-w-xl gap-2" onSubmit={excuse}>
              <Input name="reason" aria-label="Excuse reason" placeholder="Optional reason" />
              <Button type="submit" size="sm">
                Excuse Assignment
              </Button>
            </form>
          )}
          {excuseError ? <p className="mt-2 text-sm text-destructive">{excuseError}</p> : null}
        </section>
      </div>
    </main>
  );
}
