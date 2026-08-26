import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTestBackend() {
  return convexTest(schema, modules);
}

async function seed(backend: ReturnType<typeof createTestBackend>) {
  return await backend.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", { name: "North", slug: "north" });
    const studentId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-student",
      username: "student",
      displayName: "Student",
      role: "student",
    });
    await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-other-student",
      username: "other-student",
      displayName: "Other Student",
      role: "student",
    });
    const teacherId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-teacher",
      username: "teacher",
      displayName: "Teacher",
      role: "teacher",
    });
    await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-other-teacher",
      username: "other-teacher",
      displayName: "Other Teacher",
      role: "teacher",
    });
    const courseId = await ctx.db.insert("courses", { organizationId, name: "CS101" });
    const classroomId = await ctx.db.insert("classrooms", {
      organizationId,
      courseId,
      name: "Period 1",
    });
    await ctx.db.insert("classroomTeachers", { organizationId, classroomId, teacherId });
    const enrollmentId = await ctx.db.insert("enrollments", {
      organizationId,
      classroomId,
      studentId,
      status: "ended",
      endedAt: 2,
    });
    const assignmentId = await ctx.db.insert("assignments", {
      organizationId,
      courseId,
      title: "Greeting",
      latestVersion: 1,
    });
    const assignmentVersionId = await ctx.db.insert("assignmentVersions", {
      organizationId,
      assignmentId,
      version: 1,
      instructions: "Greet",
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
      publicationState: "draft",
      createdBy: teacherId,
      createdAt: 1,
    });
    const workspaceId = await ctx.db.insert("workspaces", {
      organizationId,
      assignmentReleaseId,
      assignmentVersionId,
      studentId,
      files: [{ path: "main.py", content: "current" }],
      historyAckSequence: 2,
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("workHistoryChunks", {
      organizationId,
      workspaceId,
      studentId,
      startSequence: 1,
      endSequence: 2,
      eventCount: 2,
      contentHash: "chunk-hash",
      objectKey: "history/chunk.gz",
      byteLength: 10,
      encoding: "gzip-json-v1",
      snapshotHash: "snapshot-hash",
      snapshotObjectKey: "history/snapshot.gz",
      snapshotByteLength: 11,
      committedAt: 1,
    });
    return { enrollmentId, workspaceId };
  });
}

describe("Work History replay authorization", () => {
  it("allows the Student owner and assigned Classroom Teacher after active access has ended", async () => {
    const backend = createTestBackend();
    const { workspaceId } = await seed(backend);
    const student = backend.withIdentity({ subject: "auth-student" });
    const teacher = backend.withIdentity({ subject: "auth-teacher" });

    await expect(
      student.query(api.workHistoryReplay.describe, { workspaceId }),
    ).resolves.toMatchObject({
      committedThrough: 2,
      viewerRole: "student",
    });
    await expect(
      teacher.query(internal.workHistoryReplay.readPlan, { workspaceId, afterSequence: 0 }),
    ).resolves.toMatchObject({ chunk: { startSequence: 1, endSequence: 2 } });
  });

  it("denies other Students and unassigned Teachers", async () => {
    const backend = createTestBackend();
    const { workspaceId } = await seed(backend);

    await expect(
      backend
        .withIdentity({ subject: "auth-other-student" })
        .query(api.workHistoryReplay.describe, { workspaceId }),
    ).rejects.toThrow("Forbidden");
    await expect(
      backend
        .withIdentity({ subject: "auth-other-teacher" })
        .query(internal.workHistoryReplay.readPlan, { workspaceId, afterSequence: 0 }),
    ).rejects.toThrow("Forbidden");
  });

  it("lists only history belonging to the reader's preserved academic relationship", async () => {
    const backend = createTestBackend();
    const { workspaceId } = await seed(backend);

    await expect(
      backend.withIdentity({ subject: "auth-student" }).query(api.workHistoryReplay.listAccessible),
    ).resolves.toEqual([expect.objectContaining({ workspaceId })]);
    await expect(
      backend
        .withIdentity({ subject: "auth-other-teacher" })
        .query(api.workHistoryReplay.listAccessible),
    ).resolves.toEqual([]);
  });
});
