import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTestBackend() {
  return convexTest(schema, modules);
}

async function seed(backend: ReturnType<typeof createTestBackend>) {
  const ids = await backend.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", { name: "North", slug: "north" });
    const otherOrganizationId = await ctx.db.insert("organizations", {
      name: "South",
      slug: "south",
    });
    const teacherId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "teacher-auth",
      username: "teacher",
      displayName: "Teacher",
      role: "teacher",
    });
    const otherTeacherId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "other-teacher-auth",
      username: "other-teacher",
      displayName: "Other Teacher",
      role: "teacher",
    });
    const studentId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "student-auth",
      username: "student",
      displayName: "Ada Student",
      role: "student",
    });
    await ctx.db.insert("users", {
      organizationId: otherOrganizationId,
      authUserId: "outsider-auth",
      username: "student",
      displayName: "Outsider",
      role: "student",
    });
    return { organizationId, otherTeacherId, studentId, teacherId };
  });
  const teacher = backend.withIdentity({ subject: "teacher-auth" });
  const student = backend.withIdentity({ subject: "student-auth" });
  const courseId = await teacher.mutation(api.courses.create, { name: "CS101" });
  const classroomId = await teacher.mutation(api.classrooms.create, { courseId, name: "Period 1" });
  await teacher.mutation(api.enrollments.enroll, { classroomId, studentId: ids.studentId });
  const assignment = await teacher.mutation(api.assignments.create, {
    courseId,
    title: "Hello",
    instructions: "Print hello.",
    runtimeVersion: "3.12.0",
    entrypoint: "main.py",
    starterFiles: [{ path: "main.py", content: "print('hello')\n" }],
    evaluationTests: [],
  });
  return { ...ids, assignment, backend, classroomId, courseId, student, teacher };
}

describe("Notifications", () => {
  it("notifies Students when Assignment Releases become available or adopt a newer Version", async () => {
    const context = await seed(createTestBackend());
    const scheduledFor = Date.now() - 1;
    const releaseId = await context.backend.run(
      async (ctx) =>
        await ctx.db.insert("assignmentReleases", {
          organizationId: context.organizationId,
          classroomId: context.classroomId,
          assignmentId: context.assignment.assignmentId,
          assignmentVersionId: context.assignment.assignmentVersionId,
          points: 10,
          order: 0,
          publicationState: "scheduled",
          scheduledFor,
          scheduledBy: context.teacherId,
          createdBy: context.teacherId,
          createdAt: scheduledFor - 1,
        }),
    );
    await context.backend.mutation(internal.assignmentReleases.publishScheduled, {
      assignmentReleaseId: releaseId,
      scheduledFor,
    });
    await context.backend.mutation(internal.assignmentReleases.publishScheduled, {
      assignmentReleaseId: releaseId,
      scheduledFor,
    });
    const newerVersionId = await context.teacher.mutation(api.assignments.createVersion, {
      assignmentId: context.assignment.assignmentId,
      instructions: "Print a greeting.",
      runtimeVersion: "3.12.0",
      entrypoint: "main.py",
      starterFiles: [{ path: "main.py", content: "print('hi')\n" }],
      evaluationTests: [],
    });
    await context.teacher.mutation(api.assignmentReleases.adoptVersion, {
      assignmentReleaseId: releaseId,
      assignmentVersionId: newerVersionId,
    });

    expect(await context.student.query(api.notifications.listMine, {})).toMatchObject([
      { type: "assignment_changed", assignmentReleaseId: releaseId },
      { type: "assignment_available", assignmentReleaseId: releaseId },
    ]);
  });

  it("notifies Students for Material publication and adoption without duplicate scheduled retries", async () => {
    const context = await seed(createTestBackend());
    const first = await context.teacher.mutation(api.materials.create, {
      courseId: context.courseId,
      title: "Reference",
      content: { kind: "rich_text", richText: "Version one" },
    });
    const scheduledFor = Date.now() - 1;
    const releaseId = await context.backend.run(
      async (ctx) =>
        await ctx.db.insert("materialReleases", {
          organizationId: context.organizationId,
          classroomId: context.classroomId,
          materialId: first.materialId,
          materialVersionId: first.materialVersionId,
          order: 0,
          publicationState: "scheduled",
          scheduledFor,
          scheduledBy: context.teacherId,
          createdBy: context.teacherId,
          createdAt: scheduledFor - 1,
        }),
    );
    await context.backend.mutation(internal.materialReleases.publishScheduled, {
      materialReleaseId: releaseId,
      scheduledFor,
    });
    await context.backend.mutation(internal.materialReleases.publishScheduled, {
      materialReleaseId: releaseId,
      scheduledFor,
    });
    const newerVersionId = await context.teacher.mutation(api.materials.createVersion, {
      materialId: first.materialId,
      content: { kind: "rich_text", richText: "Version two" },
    });
    await context.teacher.mutation(api.materialReleases.adoptVersion, {
      materialReleaseId: releaseId,
      materialVersionId: newerVersionId,
    });

    expect(await context.student.query(api.notifications.listMine, {})).toMatchObject([
      { type: "material_changed", materialReleaseId: releaseId },
      { type: "material_available", materialReleaseId: releaseId },
    ]);
  });

  it("notifies every current Classroom Teacher when a Submission needs review", async () => {
    const context = await seed(createTestBackend());
    await context.teacher.mutation(api.classrooms.addTeacher, {
      classroomId: context.classroomId,
      username: "other-teacher",
    });
    const releaseId = await context.teacher.mutation(api.assignmentReleases.create, {
      classroomId: context.classroomId,
      assignmentVersionId: context.assignment.assignmentVersionId,
      points: 10,
    });
    const workspaceId = await context.backend.run(
      async (ctx) =>
        await ctx.db.insert("workspaces", {
          organizationId: context.organizationId,
          assignmentReleaseId: releaseId,
          assignmentVersionId: context.assignment.assignmentVersionId,
          studentId: context.studentId,
          files: [{ path: "main.py", content: "print('hello')\n" }],
          createdAt: 1,
          updatedAt: 1,
        }),
    );
    const submission = await context.student.mutation(internal.submissions.record, {
      workspaceId,
      organizationId: context.organizationId,
      studentId: context.studentId,
      assignmentReleaseId: releaseId,
      assignmentVersionId: context.assignment.assignmentVersionId,
      runtimeVersion: "3.12.0",
      entrypoint: "main.py",
      historySequence: 1,
      idempotencyKey: "submit-once",
      snapshot: {
        objectKey: "snapshots/one",
        contentHash: "a".repeat(64),
        byteLength: 10,
        files: [{ path: "main.py", contentHash: "b".repeat(64), byteLength: 15 }],
      },
      execution: { status: "completed", stdout: "hello\n", stderr: "", exitCode: 0, signal: null },
      testResults: [],
      proposedPoints: 0,
    });

    const primary = await context.teacher.query(api.notifications.listMine, {});
    const other = await context.backend
      .withIdentity({ subject: "other-teacher-auth" })
      .query(api.notifications.listMine, {});
    expect(primary).toMatchObject([
      {
        type: "submission_needs_review",
        submissionId: submission._id,
        href: `/gradebook/${context.classroomId}/${releaseId}/${context.studentId}`,
      },
    ]);
    expect(other).toMatchObject([
      { type: "submission_needs_review", submissionId: submission._id },
    ]);
    await context.backend.run(async (ctx) => {
      const assignment = await ctx.db
        .query("classroomTeachers")
        .withIndex("by_classroom_teacher", (index) =>
          index.eq("classroomId", context.classroomId).eq("teacherId", context.otherTeacherId),
        )
        .unique();
      if (assignment) await ctx.db.delete(assignment._id);
    });
    expect(
      await context.backend
        .withIdentity({ subject: "other-teacher-auth" })
        .query(api.notifications.listMine, {}),
    ).toEqual([]);
  });

  it("notifies the Student on every explicit Grade return and supports authorized read state", async () => {
    const context = await seed(createTestBackend());
    const releaseId = await context.teacher.mutation(api.assignmentReleases.create, {
      classroomId: context.classroomId,
      assignmentVersionId: context.assignment.assignmentVersionId,
      points: 10,
    });
    const submissionId = await context.backend.run(async (ctx) => {
      const workspaceId = await ctx.db.insert("workspaces", {
        organizationId: context.organizationId,
        assignmentReleaseId: releaseId,
        assignmentVersionId: context.assignment.assignmentVersionId,
        studentId: context.studentId,
        files: [],
        createdAt: 1,
        updatedAt: 1,
      });
      const snapshotId = await ctx.db.insert("submissionSnapshots", {
        organizationId: context.organizationId,
        workspaceId,
        assignmentVersionId: context.assignment.assignmentVersionId,
        historySequence: 1,
        objectKey: "snapshot",
        contentHash: "a".repeat(64),
        byteLength: 2,
        files: [],
        createdAt: 1,
      });
      return await ctx.db.insert("submissions", {
        organizationId: context.organizationId,
        workspaceId,
        assignmentReleaseId: releaseId,
        assignmentVersionId: context.assignment.assignmentVersionId,
        studentId: context.studentId,
        snapshotId,
        idempotencyKey: "seed",
        attemptNumber: 1,
        runtimeVersion: "3.12.0",
        entrypoint: "main.py",
        execution: { status: "completed", stdout: "", stderr: "", exitCode: 0, signal: null },
        testResults: [],
        proposedPoints: 8,
        submittedAt: 1,
      });
    });
    const gradeId = await context.teacher.mutation(api.grades.saveDraft, {
      submissionId,
      points: 8,
      inlineFeedback: [],
    });
    await context.teacher.mutation(api.grades.returnGrade, { gradeId });
    await context.teacher.mutation(api.grades.returnGrade, { gradeId });
    const notifications = await context.student.query(api.notifications.listMine, {});
    expect(notifications.map(({ type }: { type: string }) => type)).toEqual([
      "grade_returned",
      "grade_returned",
      "assignment_available",
    ]);
    await context.student.mutation(api.notifications.markRead, {
      notificationId: notifications[0]!._id,
    });
    expect((await context.student.query(api.notifications.listMine, {}))[0]?.readAt).toEqual(
      expect.any(Number),
    );
    await expect(
      context.backend
        .withIdentity({ subject: "outsider-auth" })
        .mutation(api.notifications.markRead, {
          notificationId: notifications[1]!._id,
        }),
    ).rejects.toThrow("Forbidden");
  });

  it("stops returning Notifications after the recipient loses current Classroom access", async () => {
    const context = await seed(createTestBackend());
    await context.teacher.mutation(api.assignmentReleases.create, {
      classroomId: context.classroomId,
      assignmentVersionId: context.assignment.assignmentVersionId,
      points: 10,
    });
    expect(await context.student.query(api.notifications.listMine, {})).toHaveLength(1);
    await context.backend.run(async (ctx) => {
      const enrollment = await ctx.db
        .query("enrollments")
        .withIndex("by_classroom_student", (index) =>
          index.eq("classroomId", context.classroomId).eq("studentId", context.studentId),
        )
        .unique();
      if (enrollment) await ctx.db.patch(enrollment._id, { status: "ended", endedAt: Date.now() });
    });
    expect(await context.student.query(api.notifications.listMine, {})).toEqual([]);
  });
});
