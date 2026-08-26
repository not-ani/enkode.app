import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seed(backend: ReturnType<typeof convexTest>) {
  return await backend.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", { name: "North", slug: "north" });
    const otherOrganizationId = await ctx.db.insert("organizations", {
      name: "South",
      slug: "south",
    });
    const teacherId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "teacher",
      username: "teacher",
      displayName: "Teacher",
      role: "teacher",
    });
    const unauthorizedTeacherId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "unauthorized-teacher",
      username: "other-teacher",
      displayName: "Other teacher",
      role: "teacher",
    });
    const outsiderId = await ctx.db.insert("users", {
      organizationId: otherOrganizationId,
      authUserId: "outsider",
      username: "outsider",
      displayName: "Outsider",
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
      createdBy: teacherId,
      createdAt: 1,
    });
    const workspaceId = await ctx.db.insert("workspaces", {
      organizationId,
      assignmentReleaseId,
      assignmentVersionId,
      studentId,
      files: [{ path: "main.py", content: "print('changed workspace')" }],
      createdAt: 1,
      updatedAt: 1,
    });
    return {
      organizationId,
      unauthorizedTeacherId,
      outsiderId,
      teacherId,
      studentId,
      assignmentReleaseId,
      assignmentVersionId,
      classroomId,
      workspaceId,
    };
  });
}

async function addSubmission(
  backend: ReturnType<typeof convexTest>,
  seeded: Awaited<ReturnType<typeof seed>>,
  attemptNumber: number,
  proposedPoints: number,
) {
  return await backend.run(async (ctx) => {
    const contentHash = String(attemptNumber).repeat(64);
    const snapshotId = await ctx.db.insert("submissionSnapshots", {
      organizationId: seeded.organizationId,
      workspaceId: seeded.workspaceId,
      assignmentVersionId: seeded.assignmentVersionId,
      historySequence: attemptNumber,
      objectKey: `snapshot-${attemptNumber}`,
      contentHash: `snapshot-${attemptNumber}`,
      byteLength: 20,
      files: [{ path: "main.py", contentHash, byteLength: 20 }],
      createdAt: attemptNumber,
    });
    return await ctx.db.insert("submissions", {
      organizationId: seeded.organizationId,
      workspaceId: seeded.workspaceId,
      assignmentReleaseId: seeded.assignmentReleaseId,
      assignmentVersionId: seeded.assignmentVersionId,
      studentId: seeded.studentId,
      snapshotId,
      idempotencyKey: `attempt-${attemptNumber}`,
      attemptNumber,
      runtimeVersion: "3.12.0",
      entrypoint: "main.py",
      execution: {
        status: "completed",
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
      },
      testResults: [],
      proposedPoints,
      submittedAt: attemptNumber,
    });
  });
}

const feedback = {
  path: "main.py",
  startLine: 1,
  startColumn: 1,
  endLine: 1,
  endColumn: 6,
  body: "Name this value.",
};

describe("grading and explicit return", () => {
  it("keeps drafts private, accepts overrides, anchors feedback, and audits returns", async () => {
    const backend = convexTest(schema, modules);
    const seeded = await seed(backend);
    const submissionId = await addSubmission(backend, seeded, 1, 6);
    const teacher = backend.withIdentity({ subject: "teacher" });
    const student = backend.withIdentity({ subject: "student" });

    const gradeId = await teacher.mutation(api.grades.saveDraft, {
      submissionId,
      points: 8,
      overallFeedback: "Good structure.",
      inlineFeedback: [feedback],
    });
    expect(
      await student.query(api.grades.mine, {
        assignmentReleaseId: seeded.assignmentReleaseId,
      }),
    ).toEqual({ status: "awaiting_review", returned: null });

    await teacher.mutation(api.grades.returnGrade, { gradeId });
    const visible = await student.query(api.grades.mine, {
      assignmentReleaseId: seeded.assignmentReleaseId,
    });
    expect(visible).toMatchObject({
      status: "returned",
      returned: {
        submissionId,
        proposedPoints: 6,
        points: 8,
        overallFeedback: "Good structure.",
        revision: 1,
        inlineFeedback: [{ ...feedback, snapshotFileContentHash: "1".repeat(64) }],
      },
    });
    const events = await backend.run(async (ctx) => ctx.db.query("auditEvents").collect());
    expect(events).toMatchObject([{ action: "grade.returned", targetKind: "grade_return" }]);
  });

  it("keeps the returned revision visible while a resubmission and draft revision await review", async () => {
    const backend = convexTest(schema, modules);
    const seeded = await seed(backend);
    const firstSubmissionId = await addSubmission(backend, seeded, 1, 5);
    const teacher = backend.withIdentity({ subject: "teacher" });
    const student = backend.withIdentity({ subject: "student" });
    const gradeId = await teacher.mutation(api.grades.saveDraft, {
      submissionId: firstSubmissionId,
      points: 5,
      overallFeedback: "First return",
      inlineFeedback: [],
    });
    await teacher.mutation(api.grades.returnGrade, { gradeId });

    const laterSubmissionId = await addSubmission(backend, seeded, 2, 9);
    expect(
      await student.query(api.grades.mine, {
        assignmentReleaseId: seeded.assignmentReleaseId,
      }),
    ).toMatchObject({
      status: "awaiting_review",
      returned: { submissionId: firstSubmissionId, points: 5, revision: 1 },
    });
    await teacher.mutation(api.grades.saveDraft, {
      submissionId: laterSubmissionId,
      points: 10,
      overallFeedback: "Private revision",
      inlineFeedback: [],
    });
    expect(
      await student.query(api.grades.mine, {
        assignmentReleaseId: seeded.assignmentReleaseId,
      }),
    ).toMatchObject({ returned: { submissionId: firstSubmissionId, points: 5, revision: 1 } });

    await teacher.mutation(api.grades.returnGrade, { gradeId });
    expect(
      await student.query(api.grades.mine, {
        assignmentReleaseId: seeded.assignmentReleaseId,
      }),
    ).toMatchObject({
      status: "returned",
      returned: { submissionId: laterSubmissionId, points: 10, revision: 2 },
    });
    const returns = await backend.run(async (ctx) => ctx.db.query("gradeReturns").collect());
    expect(returns.map(({ points, revision }) => ({ points, revision }))).toEqual([
      { points: 5, revision: 1 },
      { points: 10, revision: 2 },
    ]);
    const events = await backend.run(async (ctx) => ctx.db.query("auditEvents").collect());
    expect(events.map(({ action }) => action)).toEqual([
      "grade.returned",
      "grade.revised_returned",
    ]);
  });

  it("keeps Integrity Signal review independent from the returned Grade", async () => {
    const backend = convexTest(schema, modules);
    const seeded = await seed(backend);
    const submissionId = await addSubmission(backend, seeded, 1, 7);
    const teacher = backend.withIdentity({ subject: "teacher" });
    const student = backend.withIdentity({ subject: "student" });
    const gradeId = await teacher.mutation(api.grades.saveDraft, {
      submissionId,
      points: 8,
      inlineFeedback: [],
    });
    await teacher.mutation(api.grades.returnGrade, { gradeId });
    const beforeReview = await student.query(api.grades.mine, {
      assignmentReleaseId: seeded.assignmentReleaseId,
    });
    const signalId = await backend.run(async (ctx) =>
      ctx.db.insert("integritySignals", {
        organizationId: seeded.organizationId,
        workspaceId: seeded.workspaceId,
        studentId: seeded.studentId,
        type: "large_paste",
        state: "open",
        evidenceKey: "grade-independent-signal",
        eventSequence: 1,
        path: "main.py",
        insertedCharacters: 100,
        deletedCharacters: 0,
        resultingFileCharacters: 100,
        contribution: 1,
        createdAt: 1,
      }),
    );

    await teacher.mutation(api.integritySignals.review, {
      signalId,
      state: "reviewed",
      note: "Reviewed separately from grading.",
    });

    expect(
      await student.query(api.grades.mine, {
        assignmentReleaseId: seeded.assignmentReleaseId,
      }),
    ).toEqual(beforeReview);
    expect(await backend.run(async (ctx) => ctx.db.get(gradeId))).toMatchObject({
      points: 8,
      proposedPoints: 7,
      submissionId,
    });
  });

  it("enforces Classroom Teacher authority, score bounds, and snapshot paths", async () => {
    const backend = convexTest(schema, modules);
    const seeded = await seed(backend);
    const submissionId = await addSubmission(backend, seeded, 1, 5);
    const input = { submissionId, points: 5, inlineFeedback: [] };
    await expect(
      backend.withIdentity({ subject: "student" }).mutation(api.grades.saveDraft, input),
    ).rejects.toThrow("Forbidden");
    await expect(
      backend
        .withIdentity({ subject: "unauthorized-teacher" })
        .mutation(api.grades.saveDraft, input),
    ).rejects.toThrow("Forbidden");
    await expect(
      backend.withIdentity({ subject: "outsider" }).mutation(api.grades.saveDraft, input),
    ).rejects.toThrow("Forbidden");
    const teacher = backend.withIdentity({ subject: "teacher" });
    await expect(teacher.mutation(api.grades.saveDraft, { ...input, points: 11 })).rejects.toThrow(
      "between 0 and 10",
    );
    await expect(
      teacher.mutation(api.grades.saveDraft, {
        ...input,
        inlineFeedback: [{ ...feedback, path: "not-in-snapshot.py" }],
      }),
    ).rejects.toThrow("not part of the selected Submission");
  });

  it("maintains one Grade for a Student and Assignment Release", async () => {
    const backend = convexTest(schema, modules);
    const seeded = await seed(backend);
    const first = await addSubmission(backend, seeded, 1, 4);
    const second = await addSubmission(backend, seeded, 2, 7);
    const teacher = backend.withIdentity({ subject: "teacher" });
    const firstGradeId = await teacher.mutation(api.grades.saveDraft, {
      submissionId: first,
      points: 4,
      inlineFeedback: [],
    });
    const secondGradeId = await teacher.mutation(api.grades.saveDraft, {
      submissionId: second,
      points: 7,
      inlineFeedback: [],
    });
    expect(secondGradeId).toBe(firstGradeId);
    const grades = await backend.run(async (ctx) => ctx.db.query("grades").collect());
    expect(grades).toHaveLength(1);
    expect(grades[0]?.submissionId).toBe(second);
  });

  it("keeps grading bound to an old-version Submission after the release advances", async () => {
    const backend = convexTest(schema, modules);
    const seeded = await seed(backend);
    const submissionId = await addSubmission(backend, seeded, 1, 6);
    await backend.run(async (ctx) => {
      const current = (await ctx.db.get(seeded.assignmentVersionId))!;
      const newerVersionId = await ctx.db.insert("assignmentVersions", {
        organizationId: current.organizationId,
        assignmentId: current.assignmentId,
        version: 2,
        instructions: "Updated instructions",
        language: current.language,
        runtimeVersion: current.runtimeVersion,
        entrypoint: current.entrypoint,
        createdBy: current.createdBy,
        createdAt: 2,
      });
      await ctx.db.patch(seeded.assignmentReleaseId, { assignmentVersionId: newerVersionId });
    });

    const teacher = backend.withIdentity({ subject: "teacher" });
    const review = await teacher.query(api.grades.review, {
      assignmentReleaseId: seeded.assignmentReleaseId,
      studentId: seeded.studentId,
    });
    expect(review.attempts[0]).toMatchObject({
      _id: submissionId,
      assignmentVersionId: seeded.assignmentVersionId,
      assignmentVersion: 1,
      snapshotFiles: [{ path: "main.py", contentHash: "1".repeat(64) }],
    });
    await expect(
      teacher.mutation(api.grades.saveDraft, {
        submissionId,
        points: 6,
        inlineFeedback: [feedback],
      }),
    ).resolves.toBeDefined();
  });
});
