import { api } from "@/lib/convex-api";
import { Button } from "@enkode.app/ui/components/button";
import { Input } from "@enkode.app/ui/components/input";
import { Textarea } from "@enkode.app/ui/components/textarea";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { messageFrom } from "@/lib/error-message";

type Classroom = FunctionReturnType<typeof api.classrooms.listMine>[number];
export type QueueRow = FunctionReturnType<typeof api.grades.reviewQueue>[number];
type InlineFeedback = {
  path: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  body: string;
};
type Review = NonNullable<FunctionReturnType<typeof api.grades.review>>;

export default function Grading({ classrooms }: { classrooms: Classroom[] }) {
  const [classroomId, setClassroomId] = useState(classrooms[0]?._id ?? "");
  const selectedClassroomId = classrooms.some(({ _id }) => _id === classroomId)
    ? classroomId
    : (classrooms[0]?._id ?? "");
  const queue = useQuery(
    api.grades.reviewQueue,
    selectedClassroomId ? { classroomId: selectedClassroomId } : "skip",
  );
  const [selection, setSelection] = useState<string>();
  const selected =
    queue?.find((row) => `${row.assignmentReleaseId}:${row.studentId}` === selection) ?? queue?.[0];

  return (
    <section className="flex flex-col gap-5 border-t border-foreground/10 pt-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-balance text-xl font-semibold">Grading</h2>
        <p className="max-w-[70ch] text-pretty text-base text-muted-foreground sm:text-sm">
          Select a retained Submission, adjust its proposed points, add Feedback, then explicitly
          return it to the Student.
        </p>
      </div>
      {classrooms.length === 0 ? (
        <p className="text-base text-muted-foreground sm:text-sm">
          Create a Classroom before grading Submissions.
        </p>
      ) : (
        <>
          <label className="flex max-w-md flex-col gap-1.5 text-base sm:text-sm">
            Classroom
            <select
              value={selectedClassroomId}
              onChange={(event) => {
                setClassroomId(event.target.value);
                setSelection(undefined);
              }}
              className="h-10 min-w-0 border border-input bg-background px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 sm:h-8 sm:text-xs"
            >
              {classrooms.map((classroom) => (
                <option value={classroom._id} key={classroom._id}>
                  {classroom.name} · {classroom.courseName}
                </option>
              ))}
            </select>
          </label>
          {!queue ? (
            <p className="text-sm text-muted-foreground">Loading Submissions…</p>
          ) : queue.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Submissions are ready to review.</p>
          ) : (
            <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
              <ol className="divide-y divide-foreground/10 border-y border-foreground/10">
                {queue.map((row) => {
                  const key = `${row.assignmentReleaseId}:${row.studentId}`;
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        aria-current={selected === row ? "true" : undefined}
                        className="w-full px-3 py-3 text-left hover:bg-muted/50 aria-current:bg-muted"
                        onClick={() => setSelection(key)}
                      >
                        <span className="block truncate font-medium">{row.studentName}</span>
                        <span className="block truncate text-sm text-muted-foreground">
                          {row.assignmentTitle} · {row.attemptCount} attempt
                          {row.attemptCount === 1 ? "" : "s"} · {row.status.replace("_", " ")}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
              {selected ? (
                <GradeEditor
                  key={`${selected.assignmentReleaseId}:${selected.studentId}`}
                  row={selected}
                />
              ) : null}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function GradeEditor({ row }: { row: QueueRow }) {
  const review = useQuery(api.grades.review, {
    assignmentReleaseId: row.assignmentReleaseId,
    studentId: row.studentId,
  });
  if (!review) return <p className="text-sm text-muted-foreground">Loading review…</p>;
  return <GradeForm review={review} row={row} />;
}

function GradeForm({ review, row }: { review: Review; row: QueueRow }) {
  const saveDraft = useMutation(api.grades.saveDraft);
  const returnGrade = useMutation(api.grades.returnGrade);
  const initialSubmissionId = review.grade?.submissionId ?? review.attempts[0]?._id ?? "";
  const [submissionId, setSubmissionId] = useState(initialSubmissionId);
  const selectedAttempt =
    review.attempts.find(({ _id }) => _id === submissionId) ?? review.attempts[0]!;
  const [points, setPoints] = useState(review.grade?.points ?? selectedAttempt.proposedPoints);
  const [overallFeedback, setOverallFeedback] = useState(review.grade?.overallFeedback ?? "");
  const [inlineFeedback, setInlineFeedback] = useState<InlineFeedback[]>(
    review.grade?.inlineFeedback ?? [],
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const proposedPoints = selectedAttempt.proposedPoints;
  const paths = useMemo(
    () => selectedAttempt.snapshotFiles.map(({ path }) => path),
    [selectedAttempt.snapshotFiles],
  );

  useEffect(() => {
    if (review.grade?.submissionId === submissionId) return;
    setPoints(selectedAttempt.proposedPoints);
    setInlineFeedback([]);
  }, [review.grade?.submissionId, selectedAttempt.proposedPoints, submissionId]);

  async function persist() {
    return await saveDraft({ submissionId, points, overallFeedback, inlineFeedback });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(undefined);
    try {
      await persist();
      setMessage("Grade draft saved privately.");
    } catch (error) {
      setMessage(messageFrom(error, "Could not save this Grade"));
    } finally {
      setSaving(false);
    }
  }

  async function returnToStudent() {
    setSaving(true);
    setMessage(undefined);
    try {
      const gradeId = await persist();
      await returnGrade({ gradeId });
      setMessage(review.returned ? "Revised Grade returned." : "Grade returned.");
    } catch (error) {
      setMessage(messageFrom(error, "Could not save this Grade"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="flex min-w-0 flex-col gap-5 border border-foreground/10 p-4" onSubmit={save}>
      <div>
        <h3 className="font-medium">
          {row.studentName} · {row.assignmentTitle}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {review.status.replace("_", " ")}
          {review.returned
            ? ` · Revision ${review.returned.revision} returned ${new Date(review.returned.returnedAt).toLocaleString()}`
            : " · Private until returned"}
        </p>
      </div>
      <label className="flex max-w-sm flex-col gap-1.5 text-sm">
        Retained Submission
        <select
          value={submissionId}
          onChange={(event) => setSubmissionId(event.target.value)}
          className="h-9 border border-input bg-background px-2.5 outline-none"
        >
          {review.attempts.map((attempt) => (
            <option value={attempt._id} key={attempt._id}>
              Attempt {attempt.attemptNumber} · Version {attempt.assignmentVersion} ·{" "}
              {attempt.proposedPoints} proposed points
            </option>
          ))}
        </select>
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm">
          Points
          <Input
            type="number"
            min="0"
            max={review.releasePoints}
            step="any"
            value={points}
            onChange={(event) => setPoints(event.target.valueAsNumber)}
            required
          />
          <span className="text-xs text-muted-foreground">
            Evaluation proposal: {proposedPoints} · Maximum: {review.releasePoints}
          </span>
        </label>
      </div>
      <label className="flex flex-col gap-1.5 text-sm">
        Overall Feedback
        <Textarea
          value={overallFeedback}
          onChange={(event) => setOverallFeedback(event.target.value)}
          placeholder="Feedback about this Submission"
        />
      </label>
      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">Inline Feedback</legend>
        <p className="text-xs text-muted-foreground">
          Each comment is anchored to a file and range in this immutable Submission snapshot.
        </p>
        {inlineFeedback.map((feedback, index) => (
          <div className="grid gap-2 border border-foreground/10 p-3 sm:grid-cols-6" key={index}>
            <label className="flex flex-col gap-1 text-xs sm:col-span-2">
              File
              <select
                value={feedback.path}
                onChange={(event) =>
                  setInlineFeedback((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, path: event.target.value } : item,
                    ),
                  )
                }
                className="h-8 border border-input bg-background px-2"
              >
                {paths.map((path) => (
                  <option value={path} key={path}>
                    {path}
                  </option>
                ))}
              </select>
            </label>
            {(["startLine", "startColumn", "endLine", "endColumn"] as const).map((field) => (
              <label className="flex flex-col gap-1 text-xs" key={field}>
                {field.replace(/([A-Z])/g, " $1")}
                <Input
                  type="number"
                  min="1"
                  value={feedback[field]}
                  onChange={(event) =>
                    setInlineFeedback((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, [field]: event.target.valueAsNumber }
                          : item,
                      ),
                    )
                  }
                  required
                />
              </label>
            ))}
            <label className="flex flex-col gap-1 text-xs sm:col-span-5">
              Comment
              <Input
                value={feedback.body}
                onChange={(event) =>
                  setInlineFeedback((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, body: event.target.value } : item,
                    ),
                  )
                }
                required
              />
            </label>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setInlineFeedback((current) => current.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          disabled={paths.length === 0}
          onClick={() =>
            setInlineFeedback((current) => [
              ...current,
              {
                path: paths[0] ?? "",
                startLine: 1,
                startColumn: 1,
                endLine: 1,
                endColumn: 1,
                body: "",
              },
            ])
          }
        >
          Add inline Feedback
        </Button>
      </fieldset>
      {message ? (
        <p className="text-sm" aria-live="polite">
          {message}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="outline" disabled={saving}>
          {saving ? "Saving…" : "Save private draft"}
        </Button>
        <Button type="button" disabled={saving} onClick={() => void returnToStudent()}>
          {review.returned ? "Return revised Grade" : "Return Grade"}
        </Button>
      </div>
    </form>
  );
}
