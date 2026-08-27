import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seed() {
  const backend = convexTest(schema, modules);
  const ids = await backend.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", { name: "North", slug: "north" });
    const teacherId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "teacher",
      username: "teacher",
      displayName: "Teacher",
      role: "teacher",
    });
    await ctx.db.insert("users", {
      organizationId,
      authUserId: "other-teacher",
      username: "other-teacher",
      displayName: "Other",
      role: "teacher",
    });
    const studentId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "student",
      username: "student",
      displayName: "Student",
      role: "student",
    });
    const courseId = await ctx.db.insert("courses", { organizationId, name: "CS101" });
    const classroomId = await ctx.db.insert("classrooms", { organizationId, courseId, name: "P1" });
    await ctx.db.insert("classroomTeachers", { organizationId, classroomId, teacherId });
    await ctx.db.insert("enrollments", {
      organizationId,
      classroomId,
      studentId,
      status: "active",
    });
    const assignmentId = await ctx.db.insert("assignments", {
      organizationId,
      courseId,
      title: "Hello",
      latestVersion: 1,
    });
    const assignmentVersionId = await ctx.db.insert("assignmentVersions", {
      organizationId,
      assignmentId,
      version: 1,
      instructions: "Hello",
      language: "python",
      runtimeVersion: "3.12.0",
      entrypoint: "main.py",
      createdBy: teacherId,
      createdAt: 1,
    });
    const assignmentReleaseId = await ctx.db.insert("assignmentReleases", {
      organizationId,
      classroomId,
      assignmentId,
      assignmentVersionId,
      points: 10,
      order: 0,
      publicationState: "published",
      publishedAt: 1,
      deadlinePolicy: "no_deadline",
      submissionLimit: 1,
      createdBy: teacherId,
      createdAt: 1,
    });
    const workspaceId = await ctx.db.insert("workspaces", {
      organizationId,
      assignmentReleaseId,
      assignmentVersionId,
      studentId,
      files: [{ path: "main.py", content: "print(1)" }],
      createdAt: 1,
      updatedAt: 1,
    });
    return {
      organizationId,
      teacherId,
      studentId,
      classroomId,
      assignmentId,
      assignmentVersionId,
      assignmentReleaseId,
      workspaceId,
    };
  });
  return { backend, ...ids };
}

function recordInput(seeded: Awaited<ReturnType<typeof seed>>, idempotencyKey: string) {
  return {
    workspaceId: seeded.workspaceId,
    organizationId: seeded.organizationId,
    studentId: seeded.studentId,
    assignmentReleaseId: seeded.assignmentReleaseId,
    assignmentVersionId: seeded.assignmentVersionId,
    runtimeVersion: "3.12.0",
    entrypoint: "main.py",
    historySequence: 1,
    idempotencyKey,
    snapshot: { objectKey: idempotencyKey, contentHash: idempotencyKey, byteLength: 1, files: [] },
    execution: { status: "completed" as const, stdout: "", stderr: "", exitCode: 0, signal: null },
    testResults: [],
    proposedPoints: 0,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Deadline Exceptions and enforced submission policy", () => {
  it("authorizes the Classroom Teacher and audits every Deadline Exception change", async () => {
    const seeded = await seed();
    const teacher = seeded.backend.withIdentity({ subject: "teacher" });
    const otherTeacher = seeded.backend.withIdentity({ subject: "other-teacher" });
    await expect(
      otherTeacher.mutation(api.assignmentReleases.setDeadlineException, {
        assignmentReleaseId: seeded.assignmentReleaseId,
        studentId: seeded.studentId,
        deadlinePolicy: "no_deadline",
      }),
    ).rejects.toThrow("Forbidden");
    const exceptionId = await teacher.mutation(api.assignmentReleases.setDeadlineException, {
      assignmentReleaseId: seeded.assignmentReleaseId,
      studentId: seeded.studentId,
      deadlinePolicy: "hard_close",
      deadlineAt: 100,
    });
    await teacher.mutation(api.assignmentReleases.setDeadlineException, {
      assignmentReleaseId: seeded.assignmentReleaseId,
      studentId: seeded.studentId,
      deadlinePolicy: "accept_late",
      deadlineAt: 200,
    });
    await teacher.mutation(api.assignmentReleases.removeDeadlineException, {
      assignmentReleaseId: seeded.assignmentReleaseId,
      studentId: seeded.studentId,
    });
    const events = await seeded.backend.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_target", (index) =>
          index.eq("targetKind", "deadline_exception").eq("targetId", exceptionId),
        )
        .collect(),
    );
    expect(events.map(({ action }) => action)).toEqual([
      "deadline_exception.created",
      "deadline_exception.changed",
      "deadline_exception.removed",
    ]);
  });

  it("uses the Student exception for effective Deadline, missing, and availability facts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(150);
    const seeded = await seed();
    await seeded.backend.run(async (ctx) =>
      ctx.db.patch(seeded.assignmentReleaseId, { deadlinePolicy: "hard_close", deadlineAt: 100 }),
    );
    const teacher = seeded.backend.withIdentity({ subject: "teacher" });
    await teacher.mutation(api.assignmentReleases.setDeadlineException, {
      assignmentReleaseId: seeded.assignmentReleaseId,
      studentId: seeded.studentId,
      deadlinePolicy: "accept_late",
      deadlineAt: 200,
    });
    const opened = await seeded.backend
      .withIdentity({ subject: "student" })
      .query(api.assignmentReleases.open, { assignmentReleaseId: seeded.assignmentReleaseId });
    expect(opened).toMatchObject({
      effectiveDeadline: { deadlinePolicy: "accept_late", deadlineAt: 200 },
      submissionEligibility: { canSubmit: true, remainingAttempts: 1 },
      deadlineFacts: { missing: false, late: false },
    });
  });

  it("re-checks finite attempts atomically and does not charge an idempotent retry", async () => {
    const seeded = await seed();
    const student = seeded.backend.withIdentity({ subject: "student" });
    const [first, second] = await Promise.allSettled([
      student.mutation(internal.submissions.record, recordInput(seeded, "first")),
      student.mutation(internal.submissions.record, recordInput(seeded, "second")),
    ]);
    expect([first.status, second.status].sort()).toEqual(["fulfilled", "rejected"]);
    const accepted =
      first.status === "fulfilled"
        ? first.value
        : second.status === "fulfilled"
          ? second.value
          : undefined;
    expect(accepted).toBeDefined();
    const retry = await student.mutation(
      internal.submissions.record,
      recordInput(seeded, accepted!.idempotencyKey),
    );
    expect(retry._id).toBe(accepted!._id);
    expect(await seeded.backend.run((ctx) => ctx.db.query("submissions").collect())).toHaveLength(
      1,
    );
  });

  it("records accept-late facts and hard-rejects after a hard-close Deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(101);
    const seeded = await seed();
    const student = seeded.backend.withIdentity({ subject: "student" });
    await seeded.backend.run(async (ctx) =>
      ctx.db.patch(seeded.assignmentReleaseId, {
        deadlinePolicy: "accept_late",
        deadlineAt: 100,
        submissionLimit: undefined,
      }),
    );
    const late = await student.mutation(internal.submissions.record, recordInput(seeded, "late"));
    expect(late).toMatchObject({ late: true, effectiveDeadlineAt: 100 });
    await seeded.backend.run(async (ctx) =>
      ctx.db.patch(seeded.assignmentReleaseId, { deadlinePolicy: "hard_close" }),
    );
    await expect(
      student.mutation(internal.submissions.record, recordInput(seeded, "closed")),
    ).rejects.toThrow("Submissions closed");
    expect(await seeded.backend.run((ctx) => ctx.db.query("submissions").collect())).toHaveLength(
      1,
    );
  });

  it("keeps adopted-version Deadline facts immutable on historical Submissions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(101);
    const seeded = await seed();
    const secondVersionId = await seeded.backend.run(async (ctx) => {
      const id = await ctx.db.insert("assignmentVersions", {
        organizationId: seeded.organizationId,
        assignmentId: seeded.assignmentId,
        version: 2,
        instructions: "Hello again",
        language: "python",
        runtimeVersion: "3.12.0",
        entrypoint: "main.py",
        createdBy: seeded.teacherId,
        createdAt: 2,
      });
      await ctx.db.patch(seeded.assignmentId, { latestVersion: 2 });
      await ctx.db.patch(seeded.assignmentReleaseId, {
        deadlinePolicy: "accept_late",
        deadlineAt: 100,
        submissionLimit: undefined,
      });
      return id;
    });
    const teacher = seeded.backend.withIdentity({ subject: "teacher" });
    await teacher.mutation(api.assignmentReleases.adoptVersion, {
      assignmentReleaseId: seeded.assignmentReleaseId,
      assignmentVersionId: secondVersionId,
    });
    const student = seeded.backend.withIdentity({ subject: "student" });
    const submission = await student.mutation(internal.submissions.record, {
      ...recordInput(seeded, "adopted-version"),
      assignmentVersionId: secondVersionId,
    });
    await teacher.mutation(api.assignmentReleases.configureSubmissionPolicy, {
      assignmentReleaseId: seeded.assignmentReleaseId,
      deadlinePolicy: "no_deadline",
    });

    expect(submission).toMatchObject({
      assignmentVersionId: secondVersionId,
      late: true,
      effectiveDeadlineAt: 100,
    });
    expect(
      await student.query(api.submissions.mine, { workspaceId: seeded.workspaceId }),
    ).toMatchObject([
      {
        assignmentVersionId: secondVersionId,
        late: true,
        effectiveDeadlineAt: 100,
      },
    ]);
  });

  it("makes archived policy read-only while preserving history and idempotent retries", async () => {
    const seeded = await seed();
    const student = seeded.backend.withIdentity({ subject: "student" });
    const teacher = seeded.backend.withIdentity({ subject: "teacher" });
    const input = recordInput(seeded, "before-archive");
    const submission = await student.mutation(internal.submissions.record, input);

    await teacher.mutation(api.archive.archiveClassroom, { classroomId: seeded.classroomId });

    await expect(
      teacher.mutation(api.assignmentReleases.configureSubmissionPolicy, {
        assignmentReleaseId: seeded.assignmentReleaseId,
        deadlinePolicy: "hard_close",
        deadlineAt: 100,
      }),
    ).rejects.toThrow("read-only");
    await expect(
      teacher.mutation(api.assignmentReleases.setDeadlineException, {
        assignmentReleaseId: seeded.assignmentReleaseId,
        studentId: seeded.studentId,
        deadlinePolicy: "no_deadline",
      }),
    ).rejects.toThrow("read-only");
    await expect(
      student.mutation(internal.submissions.record, recordInput(seeded, "after-archive")),
    ).rejects.toThrow("read-only");

    expect(await student.mutation(internal.submissions.record, input)).toMatchObject({
      _id: submission._id,
      late: submission.late,
    });
    await expect(
      student.query(api.submissions.mine, { workspaceId: seeded.workspaceId }),
    ).resolves.toHaveLength(1);
    await expect(
      teacher.query(api.submissions.forTeacher, {
        assignmentReleaseId: seeded.assignmentReleaseId,
        studentId: seeded.studentId,
      }),
    ).resolves.toHaveLength(1);
  });
});
