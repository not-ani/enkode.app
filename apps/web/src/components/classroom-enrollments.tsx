import { api } from "@enkode.app/backend/convex/_generated/api";
import { Button } from "@enkode.app/ui/components/button";
import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";

type Classroom = { _id: string; name: string; courseName: string };
type Student = { id: string; displayName: string; username: string };
type Enrollment = {
  id: string;
  studentId: string;
  displayName: string;
  username: string;
  status: "active" | "ended";
};

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : "Could not update the Enrollment.";
}

export default function ClassroomEnrollments({ classrooms }: { classrooms: Classroom[] }) {
  const [classroomId, setClassroomId] = useState(classrooms[0]?._id ?? "");
  const [error, setError] = useState<string>();
  const selectedClassroomId = classrooms.some((classroom) => classroom._id === classroomId)
    ? classroomId
    : (classrooms[0]?._id ?? "");
  const students = useQuery(api.students.list) as Student[] | undefined;
  const enrollments = useQuery(
    api.enrollments.listForClassroom,
    selectedClassroomId ? { classroomId: selectedClassroomId } : "skip",
  ) as Enrollment[] | undefined;
  const enroll = useMutation(api.enrollments.enroll);
  const end = useMutation(api.enrollments.end);
  const restore = useMutation(api.enrollments.restore);

  const enrolledStudentIds = new Set(enrollments?.map(({ studentId }) => studentId));
  const availableStudents = students?.filter(({ id }) => !enrolledStudentIds.has(id));

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const form = new FormData(event.currentTarget);
    try {
      await enroll({ classroomId: selectedClassroomId, studentId: String(form.get("studentId")) });
      event.currentTarget.reset();
    } catch (caught) {
      setError(messageFrom(caught));
    }
  }

  async function changeStatus(enrollment: Enrollment) {
    setError(undefined);
    try {
      if (enrollment.status === "active") await end({ enrollmentId: enrollment.id });
      else await restore({ enrollmentId: enrollment.id });
    } catch (caught) {
      setError(messageFrom(caught));
    }
  }

  return (
    <section className="flex flex-col gap-4 border-t border-foreground/10 pt-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-balance text-xl font-semibold">Classroom Enrollments</h2>
        <p className="text-muted-foreground text-pretty text-base sm:text-sm">
          Enroll provisioned Students, or end and restore their Classroom access.
        </p>
      </div>
      {classrooms.length === 0 ? (
        <p className="text-muted-foreground text-base sm:text-sm">
          Create a Classroom before enrolling Students.
        </p>
      ) : (
        <>
          <label className="flex max-w-sm flex-col gap-1.5 text-base sm:text-sm">
            Classroom
            <select
              value={selectedClassroomId}
              onChange={(event) => setClassroomId(event.target.value)}
              className="border-input bg-background h-10 border px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 sm:h-8 sm:text-xs"
            >
              {classrooms.map((classroom) => (
                <option value={classroom._id} key={classroom._id}>
                  {classroom.name} · {classroom.courseName}
                </option>
              ))}
            </select>
          </label>

          <form className="flex max-w-xl flex-col gap-2 sm:flex-row" onSubmit={add}>
            <select
              name="studentId"
              aria-label="Student to enroll"
              required
              disabled={!availableStudents?.length}
              defaultValue=""
              className="border-input bg-background h-10 min-w-0 flex-1 border px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 sm:h-8 sm:text-xs"
            >
              <option value="">Select a provisioned Student</option>
              {availableStudents?.map((student) => (
                <option value={student.id} key={student.id}>
                  {student.displayName} (@{student.username})
                </option>
              ))}
            </select>
            <Button type="submit" size="sm" disabled={!availableStudents?.length}>
              Enroll Student
            </Button>
          </form>

          {enrollments?.length === 0 ? (
            <p className="text-muted-foreground text-base sm:text-sm">
              No Students enrolled in this Classroom yet.
            </p>
          ) : (
            <ul role="list" className="divide-y divide-foreground/10 border-y border-foreground/10">
              {enrollments?.map((enrollment) => (
                <li className="flex items-center justify-between gap-4 py-4" key={enrollment.id}>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{enrollment.displayName}</p>
                    <p className="text-muted-foreground truncate text-base sm:text-sm">
                      @{enrollment.username} · {enrollment.status === "active" ? "Active" : "Ended"}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void changeStatus(enrollment)}
                  >
                    {enrollment.status === "active" ? "End access" : "Restore access"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {error ? <p className="text-destructive text-base sm:text-sm">{error}</p> : null}
        </>
      )}
    </section>
  );
}
