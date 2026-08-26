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
    const otherOrganizationId = await ctx.db.insert("organizations", {
      name: "South",
      slug: "south",
    });
    const studentId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-student",
      username: "student",
      displayName: "Student",
      role: "student",
    });
    await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-other",
      username: "other",
      displayName: "Other",
      role: "student",
    });
    const courseId = await ctx.db.insert("courses", { organizationId, name: "CS101" });
    const classroomId = await ctx.db.insert("classrooms", {
      organizationId,
      courseId,
      name: "Period 1",
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
      createdBy: studentId,
      createdAt: 1,
    });
    const assignmentReleaseId = await ctx.db.insert("assignmentReleases", {
      organizationId,
      classroomId,
      assignmentId,
      assignmentVersionId,
      points: 10,
      order: 0,
      createdBy: studentId,
      createdAt: 1,
    });
    const workspaceId = await ctx.db.insert("workspaces", {
      organizationId,
      assignmentReleaseId,
      assignmentVersionId,
      studentId,
      files: [{ path: "main.py", content: "" }],
      createdAt: 1,
      updatedAt: 1,
    });
    return { organizationId, otherOrganizationId, studentId, workspaceId };
  });
}

function chunk(
  owner: Awaited<ReturnType<typeof seed>>,
  startSequence: number,
  endSequence: number,
  contentHash = `hash-${startSequence}`,
) {
  return {
    workspaceId: owner.workspaceId,
    organizationId: owner.organizationId,
    studentId: owner.studentId,
    startSequence,
    endSequence,
    eventCount: endSequence - startSequence + 1,
    contentHash,
    objectKey: `history/${contentHash}.gz`,
    byteLength: 10,
  };
}

describe("Work History manifest acceptance", () => {
  it("acknowledges only contiguous ranges and makes exact retries idempotent", async () => {
    const backend = createTestBackend();
    const owner = await seed(backend);

    await expect(
      backend.mutation(internal.workHistory.commitChunk, chunk(owner, 2, 2)),
    ).rejects.toThrow("sequence gap; expected 1");
    await expect(
      backend.mutation(internal.workHistory.commitChunk, chunk(owner, 1, 2)),
    ).resolves.toEqual({ acknowledgedThrough: 2 });
    await expect(
      backend.mutation(internal.workHistory.commitChunk, chunk(owner, 1, 2)),
    ).resolves.toEqual({ acknowledgedThrough: 2 });
    expect(
      await backend.run(async (ctx) => await ctx.db.query("workHistoryChunks").collect()),
    ).toHaveLength(1);
  });

  it("rejects conflicting overlap, gaps, and changed ownership", async () => {
    const backend = createTestBackend();
    const owner = await seed(backend);
    await backend.mutation(internal.workHistory.commitChunk, chunk(owner, 1, 2));

    await expect(
      backend.mutation(internal.workHistory.commitChunk, chunk(owner, 2, 3, "overlap")),
    ).rejects.toThrow("overlaps");
    await expect(
      backend.mutation(internal.workHistory.commitChunk, chunk(owner, 4, 4)),
    ).rejects.toThrow("sequence gap; expected 3");
    await expect(
      backend.mutation(internal.workHistory.commitChunk, {
        ...chunk(owner, 3, 3),
        organizationId: owner.otherOrganizationId,
      }),
    ).rejects.toThrow("ownership changed");
  });

  it("exposes acknowledgements only to the Workspace owner", async () => {
    const backend = createTestBackend();
    const owner = await seed(backend);
    await backend.mutation(internal.workHistory.commitChunk, chunk(owner, 1, 1));

    await expect(
      backend.withIdentity({ subject: "auth-student" }).query(api.workHistory.acknowledgement, {
        workspaceId: owner.workspaceId,
      }),
    ).resolves.toEqual({ acknowledgedThrough: 1 });
    await expect(
      backend.withIdentity({ subject: "auth-other" }).query(api.workHistory.acknowledgement, {
        workspaceId: owner.workspaceId,
      }),
    ).rejects.toThrow("Forbidden");
  });
});
