import { api } from "@/lib/convex-api";
import { Button } from "@enkode.app/ui/components/button";
import { Input } from "@enkode.app/ui/components/input";
import { Textarea } from "@enkode.app/ui/components/textarea";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState, type FormEvent } from "react";

import { messageFrom } from "@/lib/error-message";

import ClassroomEnrollments from "@/components/classroom-enrollments";
import AssignmentAuthoring from "@/components/assignment-authoring";
import AssignmentReleases, { StudentAssignmentReleases } from "@/components/assignment-releases";
import MaterialAuthoring from "@/components/material-authoring";
import MaterialReleases, { StudentMaterials } from "@/components/material-releases";
import LiveWorkspaces from "@/components/live-workspaces";
import Grading from "@/components/grading";
import Gradebook from "@/components/gradebook";
import StudentManagement from "@/components/student-management";
import WorkHistoryList from "@/components/work-history-list";
import ArchiveActions from "@/components/archive-actions";
import AuditEventExplorer from "@/components/audit-event-explorer";
import CourseLibrary from "@/components/course-library";

export const Route = createFileRoute("/_auth/dashboard")({ component: DashboardContent });

type CourseSummary = FunctionReturnType<typeof api.courses.listMine>[number];
type ClassroomSummary = FunctionReturnType<typeof api.classrooms.listMine>[number];
type TeacherAssignment = CourseSummary["collaborators"][number];

function DashboardContent() {
  const currentUser = useQuery(api.users.current);
  const teacherQuery = currentUser?.role === "teacher" ? {} : "skip";
  const courses = useQuery(api.courses.listMine, teacherQuery);
  const classrooms = useQuery(api.classrooms.listMine, teacherQuery);
  const archived = useQuery(api.archive.listArchived, teacherQuery);
  const createCourse = useMutation(api.courses.create);
  const createClassroom = useMutation(api.classrooms.create);
  const [courseError, setCourseError] = useState<string>();
  const [classroomError, setClassroomError] = useState<string>();
  const [creatingCourse, setCreatingCourse] = useState(false);
  const [creatingClassroom, setCreatingClassroom] = useState(false);

  if (!currentUser) {
    return <div className="p-6 text-base sm:text-sm">Loading your organization…</div>;
  }

  if (currentUser.role !== "teacher") {
    return <StudentDashboard displayName={currentUser.displayName} />;
  }

  if (!courses || !classrooms) {
    return <div className="p-6 text-base sm:text-sm">Loading your teaching workspace…</div>;
  }

  async function onCreateCourse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreatingCourse(true);
    setCourseError(undefined);
    const form = new FormData(event.currentTarget);
    try {
      await createCourse({
        name: String(form.get("courseName")),
        description: String(form.get("courseDescription")),
      });
      event.currentTarget.reset();
    } catch (error) {
      setCourseError(messageFrom(error));
    } finally {
      setCreatingCourse(false);
    }
  }

  async function onCreateClassroom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreatingClassroom(true);
    setClassroomError(undefined);
    const form = new FormData(event.currentTarget);
    try {
      await createClassroom({
        courseId: String(form.get("courseId")),
        name: String(form.get("classroomName")),
      });
      event.currentTarget.reset();
    } catch (error) {
      setClassroomError(messageFrom(error));
    } finally {
      setCreatingClassroom(false);
    }
  }

  return (
    <main className="isolate overflow-y-auto py-8 sm:py-10">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-5 sm:px-8">
        <header className="flex flex-col gap-2">
          <p className="text-muted-foreground text-base sm:text-sm">
            {currentUser.organization.name}
          </p>
          <h1 className="text-balance text-3xl font-semibold tracking-tight">Teaching workspace</h1>
          <p className="text-muted-foreground max-w-[65ch] text-pretty text-base sm:text-sm">
            Build reusable Course content, then create each Classroom that delivers it.
          </p>
        </header>

        <section className="grid gap-8 border-y border-foreground/10 py-8 lg:grid-cols-2">
          <form className="flex min-w-0 flex-col gap-4" onSubmit={onCreateCourse}>
            <div className="flex flex-col gap-1">
              <h2 className="text-balance text-lg font-medium">Create a Course</h2>
              <p className="text-muted-foreground text-pretty text-base sm:text-sm">
                Start a reusable, ordered library for assignments and Materials.
              </p>
            </div>
            <div className="flex max-w-md flex-col gap-3">
              <label className="flex flex-col gap-1.5 text-base sm:text-sm" htmlFor="courseName">
                Course name
                <Input
                  id="courseName"
                  name="courseName"
                  placeholder="CS101"
                  required
                  className="max-sm:h-10 max-sm:text-base"
                />
              </label>
              <label
                className="flex flex-col gap-1.5 text-base sm:text-sm"
                htmlFor="courseDescription"
              >
                Description
                <Textarea
                  id="courseDescription"
                  name="courseDescription"
                  placeholder="Programming foundations."
                  className="max-sm:text-base"
                />
              </label>
              {courseError ? (
                <p className="text-destructive text-base sm:text-sm">{courseError}</p>
              ) : null}
              <Button type="submit" className="self-start" disabled={creatingCourse}>
                {creatingCourse ? "Creating…" : "Create Course"}
              </Button>
            </div>
          </form>

          <form className="flex min-w-0 flex-col gap-4" onSubmit={onCreateClassroom}>
            <div className="flex flex-col gap-1">
              <h2 className="text-balance text-lg font-medium">Create a Classroom</h2>
              <p className="text-muted-foreground text-pretty text-base sm:text-sm">
                Choose a Course you collaborate on and create one delivery of it.
              </p>
            </div>
            <div className="flex max-w-md flex-col gap-3">
              <label className="flex flex-col gap-1.5 text-base sm:text-sm" htmlFor="courseId">
                Course
                <span className="inline-grid grid-cols-[1fr_--spacing(8)]">
                  <select
                    id="courseId"
                    name="courseId"
                    required
                    disabled={courses.length === 0}
                    className="border-input bg-background col-span-full row-start-1 h-10 min-w-0 appearance-none border px-2.5 pr-8 text-base outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 sm:h-8 sm:text-xs"
                  >
                    <option value="">Select a Course</option>
                    {courses.map((course) => (
                      <option value={course._id} key={course._id}>
                        {course.name}
                      </option>
                    ))}
                  </select>
                  <svg
                    viewBox="0 0 8 5"
                    width="8"
                    height="5"
                    fill="none"
                    className="pointer-events-none col-start-2 row-start-1 place-self-center"
                    aria-hidden="true"
                  >
                    <path d="M.5.5 4 4 7.5.5" stroke="currentColor" />
                  </svg>
                </span>
              </label>
              <label className="flex flex-col gap-1.5 text-base sm:text-sm" htmlFor="classroomName">
                Classroom name
                <Input
                  id="classroomName"
                  name="classroomName"
                  placeholder="Period 1 CS101"
                  required
                  disabled={courses.length === 0}
                  className="max-sm:h-10 max-sm:text-base"
                />
              </label>
              {classroomError ? (
                <p className="text-destructive text-base sm:text-sm">{classroomError}</p>
              ) : null}
              <Button
                type="submit"
                variant="outline"
                className="self-start"
                disabled={creatingClassroom || courses.length === 0}
              >
                {creatingClassroom ? "Creating…" : "Create Classroom"}
              </Button>
            </div>
          </form>
        </section>

        <div className="grid gap-10 lg:grid-cols-2">
          <TeachingList
            title="Courses"
            empty="Create your first Course to begin its reusable content library."
            items={courses}
            kind="course"
          />
          <TeachingList
            title="Classrooms"
            empty="Classrooms you teach will appear here."
            items={classrooms}
            kind="classroom"
          />
        </div>
        <ClassroomEnrollments classrooms={classrooms} />
        <AssignmentReleases classrooms={classrooms} />
        <Gradebook />
        <Grading classrooms={classrooms} />
        <MaterialReleases classrooms={classrooms} />
        <LiveWorkspaces />
        <WorkHistoryList role="teacher" />
        <AuditEventExplorer />
        {archived ? <ArchivedTeaching items={archived} /> : null}
        <StudentManagement />
      </div>
    </main>
  );
}

function ArchivedTeaching({
  items,
}: {
  items: NonNullable<FunctionReturnType<typeof api.archive.listArchived>>;
}) {
  const rows = [
    ...items.courses.map((item) => ({ ...item, label: item.name, kind: "Course" })),
    ...items.classrooms.map((item) => ({ ...item, label: item.name, kind: "Classroom" })),
    ...items.assignments.map((item) => ({ ...item, label: item.title, kind: "Assignment" })),
    ...items.materials.map((item) => ({ ...item, label: item.title, kind: "Material" })),
  ].sort((left, right) => (right.archivedAt ?? 0) - (left.archivedAt ?? 0));
  if (rows.length === 0) return null;
  return (
    <details className="border-y border-foreground/10 py-5">
      <summary className="cursor-pointer font-medium">Archived teaching</summary>
      <p className="text-muted-foreground mt-2 text-sm">
        Archived items are read-only. Academic records remain available in grading and Work History.
      </p>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2" role="list">
        {rows.map((item) => (
          <li className="bg-muted/50 flex items-baseline justify-between gap-3 p-3" key={item._id}>
            <span className="truncate text-sm">{item.label}</span>
            <span className="text-muted-foreground text-xs">{item.kind}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function StudentDashboard({ displayName }: { displayName: string }) {
  const classrooms = useQuery(api.enrollments.listMine);

  return (
    <main className="isolate p-6">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">Welcome, {displayName}</h1>
      <section className="mt-8 flex max-w-2xl flex-col gap-3">
        <h2 className="text-xl font-semibold">Your Classrooms</h2>
        {!classrooms ? (
          <p className="text-muted-foreground text-base sm:text-sm">Loading Classrooms…</p>
        ) : classrooms.length === 0 ? (
          <p className="text-muted-foreground text-base sm:text-sm">
            You do not have any active Classroom Enrollments.
          </p>
        ) : (
          <ul role="list" className="divide-y divide-foreground/10 border-y border-foreground/10">
            {classrooms.map((classroom) => (
              <li className="py-4" key={classroom.enrollmentId}>
                <p className="font-medium">{classroom.classroomName}</p>
                <p className="text-muted-foreground text-base sm:text-sm">{classroom.courseName}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <StudentAssignmentReleases />
      <StudentMaterials />
      <WorkHistoryList role="student" />
    </main>
  );
}

function TeachingList(
  props:
    | { title: string; empty: string; items: CourseSummary[]; kind: "course" }
    | { title: string; empty: string; items: ClassroomSummary[]; kind: "classroom" },
) {
  return (
    <section className="@container flex min-w-0 flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-balance text-xl font-semibold">{props.title}</h2>
        <p className="text-muted-foreground tabular-nums text-base sm:text-sm">
          {props.items.length}
        </p>
      </div>
      {props.items.length === 0 ? (
        <p className="text-muted-foreground border-t border-foreground/10 pt-5 text-pretty text-base sm:text-sm">
          {props.empty}
        </p>
      ) : (
        <ul role="list" className="divide-y divide-foreground/10 border-y border-foreground/10">
          {props.items.map((item) => {
            const isCourse = "collaborators" in item;
            const detail = isCourse
              ? item.description || "Reusable Course content library."
              : `Delivers ${item.courseName}.`;
            const assignments = isCourse ? item.collaborators : item.teachers;
            return (
              <li className="flex flex-col gap-4 py-5" key={item._id}>
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className="truncate font-medium">{item.name}</h3>
                  <p className="text-muted-foreground text-pretty text-base sm:text-sm">{detail}</p>
                </div>
                <AssignmentManager
                  resourceId={item._id}
                  kind={isCourse ? "course" : "classroom"}
                  assignments={assignments}
                />
                <ArchiveActions id={item._id} target={isCourse ? "course" : "classroom"} />
                {isCourse ? (
                  <>
                    <AssignmentAuthoring courseId={item._id} />
                    <MaterialAuthoring courseId={item._id} />
                    <CourseLibrary courseId={item._id} />
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function AssignmentManager({
  resourceId,
  kind,
  assignments,
}: {
  resourceId: string;
  kind: "course" | "classroom";
  assignments: TeacherAssignment[];
}) {
  const addCollaborator = useMutation(api.courses.addCollaborator);
  const removeCollaborator = useMutation(api.courses.removeCollaborator);
  const addTeacher = useMutation(api.classrooms.addTeacher);
  const removeTeacher = useMutation(api.classrooms.removeTeacher);
  const [error, setError] = useState<string>();

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const username = String(new FormData(event.currentTarget).get("username"));
    try {
      if (kind === "course") await addCollaborator({ courseId: resourceId, username });
      else await addTeacher({ classroomId: resourceId, username });
      event.currentTarget.reset();
    } catch (caught) {
      setError(messageFrom(caught));
    }
  }

  async function remove(teacherId: string) {
    setError(undefined);
    try {
      if (kind === "course") await removeCollaborator({ courseId: resourceId, teacherId });
      else await removeTeacher({ classroomId: resourceId, teacherId });
    } catch (caught) {
      setError(messageFrom(caught));
    }
  }

  const label = kind === "course" ? "Course Collaborators" : "Classroom Teachers";
  return (
    <div className="bg-muted/50 flex flex-col gap-3 p-4">
      <p className="font-medium text-base sm:text-sm">{label}</p>
      <ul role="list" className="flex flex-col gap-2">
        {assignments.map((assignment) => (
          <li
            className="flex min-w-0 items-center justify-between gap-3"
            key={assignment.teacherId}
          >
            <p className="min-w-0 truncate text-base sm:text-sm">
              {assignment.displayName}{" "}
              <span className="text-muted-foreground">@{assignment.username}</span>
            </p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="relative text-muted-foreground"
              onClick={() => void remove(assignment.teacherId)}
            >
              <span
                className="absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
                aria-hidden="true"
              />
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <form className="flex min-w-0 flex-col gap-2 @sm:flex-row" onSubmit={add}>
        <Input
          name="username"
          aria-label={`Teacher username for ${label}`}
          placeholder="Teacher username"
          required
          className="max-sm:h-10 max-sm:text-base"
        />
        <Button type="submit" size="sm" variant="secondary" className="@sm:shrink-0">
          Add teacher
        </Button>
      </form>
      {error ? <p className="text-destructive text-base sm:text-sm">{error}</p> : null}
    </div>
  );
}
