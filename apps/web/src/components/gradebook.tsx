import { api } from "@enkode.app/backend/convex/_generated/api";
import { Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { useState } from "react";

import { assignmentStatusLabel, type GradebookData } from "@/lib/gradebook";

type Classroom = { _id: string; name: string; courseName: string; archived: boolean };

export default function Gradebook() {
  const classrooms = useQuery(api.gradebook.listClassrooms, {}) as Classroom[] | undefined;
  const [classroomId, setClassroomId] = useState("");
  const availableClassrooms = classrooms ?? [];
  const selectedClassroomId = availableClassrooms.some(({ _id }) => _id === classroomId)
    ? classroomId
    : (availableClassrooms[0]?._id ?? "");
  const gradebook = useQuery(
    api.gradebook.forClassroom,
    selectedClassroomId ? { classroomId: selectedClassroomId } : "skip",
  ) as GradebookData | undefined;
  if (!classrooms) return <p className="text-sm text-muted-foreground">Loading Gradebook…</p>;

  return (
    <section className="flex min-w-0 flex-col gap-5 border-t border-foreground/10 pt-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-balance text-xl font-semibold">Gradebook</h2>
        <p className="max-w-[70ch] text-pretty text-base text-muted-foreground sm:text-sm">
          Assignment points and statuses for this Classroom. Enkode does not calculate a final
          course Grade.
        </p>
      </div>
      {classrooms.length === 0 ? (
        <p className="text-base text-muted-foreground sm:text-sm">
          Create a Classroom before viewing its Gradebook.
        </p>
      ) : (
        <>
          <label className="flex max-w-md flex-col gap-1.5 text-base sm:text-sm">
            Classroom
            <select
              value={selectedClassroomId}
              onChange={(event) => setClassroomId(event.target.value)}
              className="h-10 min-w-0 border border-input bg-background px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 sm:h-8 sm:text-xs"
            >
              {classrooms.map((classroom) => (
                <option value={classroom._id} key={classroom._id}>
                  {classroom.name} · {classroom.courseName}
                  {classroom.archived ? " · archived" : ""}
                </option>
              ))}
            </select>
          </label>
          {!gradebook ? (
            <p className="text-sm text-muted-foreground">Loading Gradebook…</p>
          ) : gradebook.releases.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Release an Assignment to start this Gradebook.
            </p>
          ) : gradebook.students.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Enroll a Student to start this Gradebook.
            </p>
          ) : (
            <div className="overflow-x-auto border border-foreground/10">
              <table className="w-max min-w-full border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-foreground/10 bg-muted/30">
                    <th className="sticky left-0 z-10 min-w-48 bg-background px-3 py-3 font-medium">
                      Student
                    </th>
                    {gradebook.releases.map((release) => (
                      <th className="min-w-44 px-3 py-3 font-medium" key={release.id}>
                        <span className="block">{release.assignmentTitle}</span>
                        <span className="block font-normal text-muted-foreground">
                          v{release.version} · {release.points} points
                          {release.publicationStatus === "published"
                            ? ""
                            : ` · ${release.publicationStatus}`}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-foreground/10">
                  {gradebook.students.map((student) => (
                    <tr key={student.id}>
                      <th className="sticky left-0 z-10 bg-background px-3 py-3 font-normal">
                        <span className="block font-medium">{student.displayName}</span>
                        <span className="block text-muted-foreground">
                          @{student.username}
                          {student.enrollmentStatus === "ended" ? " · ended" : ""}
                        </span>
                      </th>
                      {student.cells.map((cell, releaseIndex) => {
                        const release = gradebook.releases[releaseIndex]!;
                        return (
                          <td className="p-0" key={cell.assignmentReleaseId}>
                            <Link
                              to="/gradebook/$classroomId/$assignmentReleaseId/$studentId"
                              params={{
                                classroomId: gradebook.classroom.id,
                                assignmentReleaseId: cell.assignmentReleaseId,
                                studentId: student.id,
                              }}
                              className="block min-h-16 px-3 py-3 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                              aria-label={`Open ${student.displayName} for ${release.assignmentTitle}`}
                            >
                              <span className="block font-medium tabular-nums">
                                {cell.points === undefined
                                  ? "—"
                                  : `${cell.points} / ${release.points}`}
                              </span>
                              <span className="block text-muted-foreground">
                                {assignmentStatusLabel[cell.status]}
                              </span>
                              {cell.deadlineFacts.missing ? (
                                <span className="block text-destructive">Missing</span>
                              ) : null}
                              {cell.deadlineFacts.late ? (
                                <span className="block text-muted-foreground">Late</span>
                              ) : null}
                            </Link>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
