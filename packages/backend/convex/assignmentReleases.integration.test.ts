import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTestBackend() {
  return convexTest(schema, modules);
}

type ReleaseRow = Doc<"assignmentReleases"> & { assignmentTitle: string; version: number };

const versionInput = {
  instructions: "Print hello.",
  runtimeVersion: "3.12.0",
  entrypoint: "main.py",
  starterFiles: [{ path: "main.py", content: "print('hello')\n" }],
  evaluationTests: [
    {
      name: "greets",
      kind: "input_output" as const,
      visibility: "public" as const,
      weight: 1,
      stdin: "",
      expectedOutput: "hello\n",
    },
    {
      name: "private greeting",
      kind: "python_harness" as const,
      visibility: "hidden" as const,
      weight: 2,
      harness: "assert True\n",
      failGuidance: "Check the greeting.",
    },
  ],
};

async function seedReleaseContext(backend: ReturnType<typeof createTestBackend>) {
  const ids = await backend.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      name: "North Academy",
      slug: "north",
    });
    const teacherId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-teacher",
      username: "teacher",
      displayName: "Classroom Teacher",
      role: "teacher",
    });
    await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-unassigned",
      username: "unassigned",
      displayName: "Unassigned Teacher",
      role: "teacher",
    });
    const studentId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-student",
      username: "student",
      displayName: "Student",
      role: "student",
    });
    const otherStudentId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-other-student",
      username: "other",
      displayName: "Other Student",
      role: "student",
    });
    return { organizationId, otherStudentId, studentId, teacherId };
  });
  const teacher = backend.withIdentity({ subject: "auth-teacher" });
  const courseId = await teacher.mutation(api.courses.create, { name: "CS101" });
  const classroomId = await teacher.mutation(api.classrooms.create, {
    courseId,
    name: "Period 1",
  });
  const first = await teacher.mutation(api.assignments.create, {
    courseId,
    title: "First in Course",
    ...versionInput,
  });
  const second = await teacher.mutation(api.assignments.create, {
    courseId,
    title: "Second in Course",
    ...versionInput,
  });
  const enrollmentId = await teacher.mutation(api.enrollments.enroll, {
    classroomId,
    studentId: ids.studentId,
  });
  return { ...ids, classroomId, courseId, enrollmentId, first, second, teacher };
}

describe("Assignment Releases", () => {
  it("releases an exact version with immediate, unlimited, classroom-owned defaults", async () => {
    const backend = createTestBackend();
    const { classroomId, first, teacher, teacherId } = await seedReleaseContext(backend);

    const releaseId = await teacher.mutation(api.assignmentReleases.create, {
      classroomId,
      assignmentVersionId: first.assignmentVersionId,
      points: 25,
    });
    const release = await backend.run((ctx) => ctx.db.get(releaseId as Id<"assignmentReleases">));

    expect(release).toMatchObject({
      assignmentVersionId: first.assignmentVersionId,
      classroomId,
      createdBy: teacherId,
      order: 0,
      points: 25,
    });
    expect(release?.publishedAt).toEqual(expect.any(Number));
    expect(release?.submissionLimit).toBeUndefined();

    await teacher.mutation(api.assignments.createVersion, {
      assignmentId: first.assignmentId,
      ...versionInput,
      instructions: "Print a warmer hello.",
    });
    expect(await teacher.query(api.assignmentReleases.listForClassroom, { classroomId })).toEqual([
      expect.objectContaining({
        _id: releaseId,
        assignmentVersionId: first.assignmentVersionId,
        points: 25,
        version: 1,
      }),
    ]);
  });

  it("lets Classroom Teachers order releases independently of Course authoring order", async () => {
    const backend = createTestBackend();
    const { classroomId, first, second, teacher } = await seedReleaseContext(backend);

    const secondReleaseId = await teacher.mutation(api.assignmentReleases.create, {
      classroomId,
      assignmentVersionId: second.assignmentVersionId,
      points: 10,
    });
    const firstReleaseId = await teacher.mutation(api.assignmentReleases.create, {
      classroomId,
      assignmentVersionId: first.assignmentVersionId,
      points: 20,
    });
    expect(
      (
        (await teacher.query(api.assignmentReleases.listForClassroom, {
          classroomId,
        })) as ReleaseRow[]
      ).map(({ assignmentTitle, points }) => [assignmentTitle, points]),
    ).toEqual([
      ["Second in Course", 10],
      ["First in Course", 20],
    ]);

    await teacher.mutation(api.assignmentReleases.move, {
      assignmentReleaseId: firstReleaseId,
      direction: "up",
    });
    expect(
      (
        (await teacher.query(api.assignmentReleases.listForClassroom, {
          classroomId,
        })) as ReleaseRow[]
      ).map(({ _id }) => _id),
    ).toEqual([firstReleaseId, secondReleaseId]);
  });

  it("allows only assigned Classroom Teachers to release versions from the Classroom Course", async () => {
    const backend = createTestBackend();
    const { classroomId, first, teacher } = await seedReleaseContext(backend);
    const unassigned = backend.withIdentity({ subject: "auth-unassigned" });
    const student = backend.withIdentity({ subject: "auth-student" });

    await expect(
      unassigned.query(api.assignmentReleases.availableVersions, { classroomId }),
    ).rejects.toThrow("Forbidden");
    await expect(
      unassigned.mutation(api.assignmentReleases.create, {
        classroomId,
        assignmentVersionId: first.assignmentVersionId,
        points: 10,
      }),
    ).rejects.toThrow("Forbidden");
    await expect(
      student.mutation(api.assignmentReleases.create, {
        classroomId,
        assignmentVersionId: first.assignmentVersionId,
        points: 10,
      }),
    ).rejects.toThrow("Forbidden");

    const otherCourseId = await teacher.mutation(api.courses.create, { name: "CS102" });
    const other = await teacher.mutation(api.assignments.create, {
      courseId: otherCourseId,
      title: "Other Course Assignment",
      ...versionInput,
    });
    await expect(
      teacher.mutation(api.assignmentReleases.create, {
        classroomId,
        assignmentVersionId: other.assignmentVersionId,
        points: 10,
      }),
    ).rejects.toThrow("does not belong to this Classroom's Course");
    await expect(
      teacher.mutation(api.assignmentReleases.create, {
        classroomId,
        assignmentVersionId: first.assignmentVersionId,
        points: -1,
      }),
    ).rejects.toThrow("points must be zero or greater");
  });

  it("shows and opens published releases only for actively enrolled Students", async () => {
    const backend = createTestBackend();
    const { classroomId, enrollmentId, first, teacher } = await seedReleaseContext(backend);
    const releaseId = await teacher.mutation(api.assignmentReleases.create, {
      classroomId,
      assignmentVersionId: first.assignmentVersionId,
      points: 10,
    });
    const student = backend.withIdentity({ subject: "auth-student" });
    const otherStudent = backend.withIdentity({ subject: "auth-other-student" });

    expect(await student.query(api.assignmentReleases.listMine, {})).toEqual([
      expect.objectContaining({ _id: releaseId, assignmentTitle: "First in Course" }),
    ]);
    const opened = await student.query(api.assignmentReleases.open, {
      assignmentReleaseId: releaseId,
    });
    expect(opened.instructions).toBe(versionInput.instructions);
    expect(opened.starterFiles[0]?.content).toContain("hello");
    expect(opened.evaluationTests[1]).toMatchObject({
      visibility: "hidden",
      failGuidance: "Check the greeting.",
    });
    expect(opened.evaluationTests[1]).not.toHaveProperty("harness");
    expect(await otherStudent.query(api.assignmentReleases.listMine, {})).toEqual([]);
    await expect(
      otherStudent.query(api.assignmentReleases.open, { assignmentReleaseId: releaseId }),
    ).rejects.toThrow("Forbidden");

    await teacher.mutation(api.enrollments.end, { enrollmentId });
    expect(await student.query(api.assignmentReleases.listMine, {})).toEqual([]);
    await expect(
      student.query(api.assignmentReleases.open, { assignmentReleaseId: releaseId }),
    ).rejects.toThrow("Forbidden");
  });

  it("emits a new immutable Audit Event for each release action", async () => {
    const backend = createTestBackend();
    const { classroomId, first, second, teacher, teacherId } = await seedReleaseContext(backend);
    await teacher.mutation(api.assignmentReleases.create, {
      classroomId,
      assignmentVersionId: first.assignmentVersionId,
      points: 10,
    });
    const secondReleaseId = await teacher.mutation(api.assignmentReleases.create, {
      classroomId,
      assignmentVersionId: second.assignmentVersionId,
      points: 10,
    });
    await teacher.mutation(api.assignmentReleases.move, {
      assignmentReleaseId: secondReleaseId,
      direction: "up",
    });

    const events = await backend.run(async (ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_target", (index) =>
          index.eq("targetKind", "assignment_release").eq("targetId", secondReleaseId),
        )
        .collect(),
    );
    expect(events.map(({ action }) => action)).toEqual([
      "assignment_release.created",
      "assignment_release.reordered",
    ]);
    expect(events.every(({ actorUserId }) => actorUserId === teacherId)).toBe(true);
    expect(new Set(events.map(({ _id }) => _id)).size).toBe(2);
  });
});
