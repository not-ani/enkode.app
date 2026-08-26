import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function backend() {
  return convexTest(schema, modules);
}

async function seedAcademicRecord(test: ReturnType<typeof backend>) {
  return await test.run(async (ctx) => {
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
      authUserId: "unassigned",
      username: "unassigned",
      displayName: "Unassigned",
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
    await ctx.db.insert("courseCollaborators", { organizationId, courseId, teacherId });
    const classroomId = await ctx.db.insert("classrooms", { organizationId, courseId, name: "P1" });
    await ctx.db.insert("classroomTeachers", { organizationId, classroomId, teacherId });
    const enrollmentId = await ctx.db.insert("enrollments", {
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
      instructions: "Say hello",
      language: "python",
      runtimeVersion: "3.12.0",
      entrypoint: "main.py",
      createdBy: teacherId,
      createdAt: 1,
    });
    const starterFileId = await ctx.db.insert("assignmentStarterFiles", {
      organizationId,
      assignmentVersionId,
      path: "main.py",
      content: "print('hello')",
      order: 0,
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
      files: [{ path: "main.py", content: "print('hello')" }],
      historyAckSequence: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    const historyId = await ctx.db.insert("workHistoryChunks", {
      organizationId,
      workspaceId,
      studentId,
      startSequence: 1,
      endSequence: 1,
      eventCount: 1,
      contentHash: "h".repeat(64),
      objectKey: "history/1",
      byteLength: 10,
      encoding: "gzip-json-v1",
      committedAt: 1,
    });
    const snapshotId = await ctx.db.insert("submissionSnapshots", {
      organizationId,
      workspaceId,
      assignmentVersionId,
      historySequence: 1,
      objectKey: "snapshots/1",
      contentHash: "s".repeat(64),
      byteLength: 10,
      files: [{ path: "main.py", contentHash: "f".repeat(64), byteLength: 14 }],
      createdAt: 2,
    });
    const submissionId = await ctx.db.insert("submissions", {
      organizationId,
      workspaceId,
      assignmentReleaseId,
      assignmentVersionId,
      studentId,
      snapshotId,
      idempotencyKey: "attempt-1",
      attemptNumber: 1,
      runtimeVersion: "3.12.0",
      entrypoint: "main.py",
      execution: { status: "completed", stdout: "hello", stderr: "", exitCode: 0, signal: null },
      testResults: [],
      proposedPoints: 10,
      submittedAt: 2,
    });
    const gradeId = await ctx.db.insert("grades", {
      organizationId,
      assignmentReleaseId,
      studentId,
      submissionId,
      proposedPoints: 10,
      points: 9,
      overallFeedback: "Nice work",
      inlineFeedback: [
        {
          path: "main.py",
          snapshotFileContentHash: "f".repeat(64),
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 5,
          body: "Clear output",
        },
      ],
      updatedBy: teacherId,
      updatedAt: 3,
    });
    const gradeReturnId = await ctx.db.insert("gradeReturns", {
      organizationId,
      gradeId,
      assignmentReleaseId,
      studentId,
      submissionId,
      proposedPoints: 10,
      points: 9,
      overallFeedback: "Nice work",
      inlineFeedback: [],
      revision: 1,
      returnedBy: teacherId,
      returnedAt: 3,
    });
    await ctx.db.patch(gradeId, { latestReturnId: gradeReturnId });
    const attachmentId = await ctx.db.insert("materialAttachments", {
      organizationId,
      storageProvider: "s3-compatible",
      storageBucket: "materials",
      storageKey: "guide.pdf",
      filename: "guide.pdf",
      contentType: "application/pdf",
      byteSize: 10,
      sha256: "a".repeat(64),
      createdBy: teacherId,
      createdAt: 1,
    });
    const materialId = await ctx.db.insert("materials", {
      organizationId,
      courseId,
      title: "Guide",
      latestVersion: 1,
    });
    const materialVersionId = await ctx.db.insert("materialVersions", {
      organizationId,
      materialId,
      version: 1,
      kind: "file",
      attachmentId,
      createdBy: teacherId,
      createdAt: 1,
    });
    const materialReleaseId = await ctx.db.insert("materialReleases", {
      organizationId,
      classroomId,
      materialId,
      materialVersionId,
      order: 0,
      publicationState: "published",
      publishedAt: 1,
      createdBy: teacherId,
      createdAt: 1,
    });
    return {
      assignmentId,
      assignmentReleaseId,
      assignmentVersionId,
      attachmentId,
      classroomId,
      courseId,
      enrollmentId,
      gradeId,
      gradeReturnId,
      historyId,
      materialId,
      materialReleaseId,
      materialVersionId,
      snapshotId,
      starterFileId,
      submissionId,
      workspaceId,
    };
  });
}

describe("Archive lifecycle", () => {
  it("archives every target, removes active navigation, preserves records, and keeps history readable", async () => {
    const test = backend();
    const ids = await seedAcademicRecord(test);
    const teacher = test.withIdentity({ subject: "teacher" });
    const student = test.withIdentity({ subject: "student" });

    await teacher.mutation(api.archive.archiveAssignment, { assignmentId: ids.assignmentId });
    await teacher.mutation(api.archive.archiveMaterial, { materialId: ids.materialId });
    await teacher.mutation(api.archive.archiveCourse, { courseId: ids.courseId });
    await teacher.mutation(api.archive.archiveClassroom, { classroomId: ids.classroomId });

    expect(await teacher.query(api.courses.listMine, {})).toEqual([]);
    expect(await teacher.query(api.classrooms.listMine, {})).toEqual([]);
    expect(await teacher.query(api.assignments.listByCourse, { courseId: ids.courseId })).toEqual(
      [],
    );
    expect(await teacher.query(api.materials.listByCourse, { courseId: ids.courseId })).toEqual([]);
    expect(await student.query(api.enrollments.listMine, {})).toEqual([]);
    expect(await student.query(api.assignmentReleases.listMine, {})).toEqual([]);
    expect(await student.query(api.materialReleases.listMine, {})).toEqual([]);
    expect(await teacher.query(api.archive.listArchived, {})).toMatchObject({
      assignments: [expect.objectContaining({ _id: ids.assignmentId })],
      courses: [expect.objectContaining({ _id: ids.courseId })],
      classrooms: [expect.objectContaining({ _id: ids.classroomId })],
      materials: [expect.objectContaining({ _id: ids.materialId })],
    });

    expect(await teacher.query(api.courses.get, { courseId: ids.courseId })).toMatchObject({
      archivedAt: expect.any(Number),
    });
    expect(await teacher.query(api.classrooms.get, { classroomId: ids.classroomId })).toMatchObject(
      { archivedAt: expect.any(Number) },
    );
    expect(
      await student.query(api.assignmentReleases.open, {
        assignmentReleaseId: ids.assignmentReleaseId,
      }),
    ).toMatchObject({ assignmentTitle: "Hello" });
    expect(
      await student.query(api.materialReleases.open, { materialReleaseId: ids.materialReleaseId }),
    ).toMatchObject({ attachment: { storageKey: "guide.pdf" } });
    expect(
      await student.query(api.workHistoryReplay.describe, { workspaceId: ids.workspaceId }),
    ).toMatchObject({ committedThrough: 1 });
    expect(
      await teacher.query(api.workHistoryReplay.describe, { workspaceId: ids.workspaceId }),
    ).toMatchObject({ committedThrough: 1 });
    expect(
      await student.query(api.grades.mine, { assignmentReleaseId: ids.assignmentReleaseId }),
    ).toMatchObject({ returned: { points: 9, overallFeedback: "Nice work" } });

    await expect(
      teacher.mutation(api.assignments.createVersion, {
        assignmentId: ids.assignmentId,
        instructions: "changed",
        runtimeVersion: "3.12.0",
        entrypoint: "main.py",
        starterFiles: [{ path: "main.py", content: "" }],
        evaluationTests: [],
      }),
    ).rejects.toThrow("read-only");
    await expect(
      teacher.mutation(api.materials.createVersion, {
        materialId: ids.materialId,
        content: { kind: "rich_text", richText: "Changed" },
      }),
    ).rejects.toThrow("read-only");
    await expect(
      teacher.mutation(api.courses.update, { courseId: ids.courseId, name: "Changed" }),
    ).rejects.toThrow("read-only");
    await expect(
      teacher.mutation(api.classrooms.update, {
        classroomId: ids.classroomId,
        name: "Changed",
      }),
    ).rejects.toThrow("read-only");
    await expect(
      student.mutation(api.workspaces.save, {
        workspaceId: ids.workspaceId,
        files: [{ path: "main.py", content: "changed" }],
      }),
    ).rejects.toThrow("read-only");

    const preserved = await test.run(async (ctx) =>
      Promise.all([
        ctx.db.get(ids.enrollmentId),
        ctx.db.get(ids.historyId),
        ctx.db.get(ids.submissionId),
        ctx.db.get(ids.gradeId),
        ctx.db.get(ids.gradeReturnId),
        ctx.db.get(ids.attachmentId),
        ctx.db.get(ids.assignmentVersionId),
        ctx.db.get(ids.materialVersionId),
        ctx.db.get(ids.snapshotId),
      ]),
    );
    expect(preserved.every(Boolean)).toBe(true);
  });

  it("rejects unauthorized archive attempts", async () => {
    const test = backend();
    const ids = await seedAcademicRecord(test);
    const unassigned = test.withIdentity({ subject: "unassigned" });
    await expect(
      unassigned.mutation(api.archive.archiveCourse, { courseId: ids.courseId }),
    ).rejects.toThrow("Forbidden");
    await expect(
      unassigned.mutation(api.archive.archiveClassroom, { classroomId: ids.classroomId }),
    ).rejects.toThrow("Forbidden");
  });
});

describe("Permanent deletion", () => {
  it("deletes only unreferenced drafts and their owned version records", async () => {
    const test = backend();
    await seedAcademicRecord(test);
    const teacher = test.withIdentity({ subject: "teacher" });
    const courseId = await teacher.mutation(api.courses.create, { name: "Draft Course" });
    const assignment = await teacher.mutation(api.assignments.create, {
      courseId,
      title: "Draft Assignment",
      instructions: "Draft",
      runtimeVersion: "3.12.0",
      entrypoint: "main.py",
      starterFiles: [{ path: "main.py", content: "" }],
      evaluationTests: [],
    });
    const material = await teacher.mutation(api.materials.create, {
      courseId,
      title: "Draft Material",
      content: { kind: "rich_text", richText: "Draft" },
    });
    await teacher.mutation(api.archive.deleteAssignmentDraft, {
      assignmentId: assignment.assignmentId,
    });
    await teacher.mutation(api.archive.deleteMaterialDraft, { materialId: material.materialId });
    expect(await test.run(async (ctx) => ctx.db.get(assignment.assignmentVersionId))).toBeNull();
    expect(await test.run(async (ctx) => ctx.db.get(material.materialVersionId))).toBeNull();

    const classroomId = await teacher.mutation(api.classrooms.create, {
      courseId,
      name: "Draft Classroom",
    });
    await teacher.mutation(api.archive.deleteClassroomDraft, { classroomId });
    await teacher.mutation(api.archive.deleteCourseDraft, { courseId });
    expect(await test.run(async (ctx) => ctx.db.get(courseId))).toBeNull();
  });

  it("rejects released and otherwise referenced drafts without deleting anything", async () => {
    const test = backend();
    const ids = await seedAcademicRecord(test);
    const teacher = test.withIdentity({ subject: "teacher" });
    await expect(
      teacher.mutation(api.archive.deleteAssignmentDraft, { assignmentId: ids.assignmentId }),
    ).rejects.toThrow("released");
    await expect(
      teacher.mutation(api.archive.deleteMaterialDraft, { materialId: ids.materialId }),
    ).rejects.toThrow("released");
    await expect(
      teacher.mutation(api.archive.deleteClassroomDraft, { classroomId: ids.classroomId }),
    ).rejects.toThrow("released");
    await expect(
      teacher.mutation(api.archive.deleteCourseDraft, { courseId: ids.courseId }),
    ).rejects.toThrow("referenced");

    const draft = await teacher.mutation(api.assignments.create, {
      courseId: ids.courseId,
      title: "Referenced draft",
      instructions: "Draft",
      runtimeVersion: "3.12.0",
      entrypoint: "main.py",
      starterFiles: [{ path: "main.py", content: "" }],
      evaluationTests: [],
    });
    await teacher.mutation(api.assignmentReleases.create, {
      classroomId: ids.classroomId,
      assignmentVersionId: draft.assignmentVersionId,
      points: 1,
      publication: "draft",
    });
    await expect(
      teacher.mutation(api.archive.deleteAssignmentDraft, { assignmentId: draft.assignmentId }),
    ).rejects.toThrow("referenced");
    expect(await test.run(async (ctx) => ctx.db.get(draft.assignmentId))).not.toBeNull();
  });
});
