import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seed(backend: ReturnType<typeof convexTest>) {
  return await backend.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", { name: "North", slug: "north" });
    const studentId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "student",
      username: "student",
      displayName: "Student",
      role: "student",
    });
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
      createdBy: teacherId,
      createdAt: 1,
    });
    const workspaceId = await ctx.db.insert("workspaces", {
      organizationId,
      assignmentReleaseId,
      assignmentVersionId,
      studentId,
      files: [{ path: "main.py", content: "" }],
      historyAckSequence: 2,
      createdAt: 1,
      updatedAt: 1,
    });
    return { organizationId, studentId, workspaceId };
  });
}

describe("Integrity Signal review", () => {
  it("preserves exact missing and reordered ranges when discontinuous uploads are rejected", async () => {
    const backend = convexTest(schema, modules);
    const owner = await seed(backend);
    await backend.run(async (ctx) => {
      await ctx.db.insert("workHistoryChunks", {
        organizationId: owner.organizationId,
        workspaceId: owner.workspaceId,
        studentId: owner.studentId,
        startSequence: 1,
        endSequence: 2,
        eventCount: 2,
        contentHash: "1".repeat(64),
        objectKey: "history/1-2.gz",
        byteLength: 10,
        encoding: "gzip-json-v1",
        committedAt: 1,
      });
    });
    const student = backend.withIdentity({ subject: "student" });
    const upload = (startSequence: number, endSequence: number) =>
      student.action(api.workHistoryUpload.acceptChunk, {
        workspaceId: owner.workspaceId,
        startSequence,
        endSequence,
        eventCount: endSequence - startSequence + 1,
        contentHash: "0".repeat(64),
        byteLength: 0,
        bytes: new ArrayBuffer(0),
      });

    await expect(upload(4, 4)).rejects.toThrow("expected 3");
    await expect(upload(2, 2)).rejects.toThrow("overlaps or is behind");
    await expect(upload(1, 1)).rejects.toThrow("overlaps different content");
    const gaps = await backend.run(async (ctx) => await ctx.db.query("integritySignals").collect());
    expect(gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gapReason: "missing segment",
          sequenceStart: 3,
          sequenceEnd: 3,
        }),
        expect.objectContaining({
          gapReason: "reordered segment",
          sequenceStart: 2,
          sequenceEnd: 2,
        }),
        expect.objectContaining({
          gapReason: "unverifiable segment",
          sequenceStart: 1,
          sequenceEnd: 1,
        }),
      ]),
    );
  });

  it("links exact event and gap evidence without producing punitive outcomes", async () => {
    const backend = convexTest(schema, modules);
    const owner = await seed(backend);
    await backend.mutation(internal.integritySignals.createEventSignals, {
      ...owner,
      candidates: [
        {
          type: "large_paste",
          evidenceKey: `${owner.workspaceId}:large_paste:2`,
          eventSequence: 2,
          path: "main.py",
          insertedCharacters: 220,
          deletedCharacters: 0,
          resultingFileCharacters: 240,
          contribution: 220 / 240,
        },
      ],
    });
    await backend.mutation(internal.integritySignals.recordGap, {
      ...owner,
      evidenceKey: `${owner.workspaceId}:gap:3-4`,
      sequenceStart: 3,
      sequenceEnd: 4,
      gapReason: "missing segment",
    });

    const signals = await backend
      .withIdentity({ subject: "teacher" })
      .query(api.integritySignals.listForWorkspace, { workspaceId: owner.workspaceId });
    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "large_paste", eventSequence: 2, state: "open" }),
        expect.objectContaining({
          type: "work_history_gap",
          sequenceStart: 3,
          sequenceEnd: 4,
          state: "open",
        }),
      ]),
    );
    for (const signal of signals) {
      expect(signal).not.toHaveProperty("grade");
      expect(signal).not.toHaveProperty("misconduct");
      expect(signal).not.toHaveProperty("risk");
    }
  });

  it("allows only the assigned Teacher to review once with an optional note", async () => {
    const backend = convexTest(schema, modules);
    const owner = await seed(backend);
    const signalId = await backend.mutation(internal.integritySignals.recordGap, {
      ...owner,
      evidenceKey: `${owner.workspaceId}:gap:3`,
      sequenceStart: 3,
      sequenceEnd: 3,
      gapReason: "unverifiable segment",
    });
    await expect(
      backend.withIdentity({ subject: "student" }).query(api.integritySignals.listForWorkspace, {
        workspaceId: owner.workspaceId,
      }),
    ).rejects.toThrow("Forbidden");
    await expect(
      backend.withIdentity({ subject: "other-teacher" }).mutation(api.integritySignals.review, {
        signalId,
        state: "dismissed",
      }),
    ).rejects.toThrow("Forbidden");

    await backend.withIdentity({ subject: "teacher" }).mutation(api.integritySignals.review, {
      signalId,
      state: "reviewed",
      note: "Discussed the interrupted upload with the Student.",
    });
    const reviewed = await backend.run(async (ctx) => await ctx.db.get(signalId));
    expect(reviewed).toMatchObject({
      state: "reviewed",
      teacherNote: "Discussed the interrupted upload with the Student.",
    });
    await expect(
      backend.withIdentity({ subject: "teacher" }).mutation(api.integritySignals.review, {
        signalId,
        state: "dismissed",
      }),
    ).rejects.toThrow("already complete");
  });
});
