import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seed(backend: ReturnType<typeof convexTest>) {
  return await backend.run(async (ctx) => {
    async function organization(slug: string) {
      const organizationId = await ctx.db.insert("organizations", { name: slug, slug });
      const teacherId = await ctx.db.insert("users", {
        organizationId,
        authUserId: `${slug}-teacher`,
        username: "teacher",
        displayName: `${slug} Teacher`,
        role: "teacher",
      });
      const studentId = await ctx.db.insert("users", {
        organizationId,
        authUserId: `${slug}-student`,
        username: "student",
        displayName: `${slug} Student`,
        role: "student",
      });
      const courseId = await ctx.db.insert("courses", { organizationId, name: "CS101" });
      const assignmentId = await ctx.db.insert("assignments", {
        organizationId,
        courseId,
        title: "Normalize",
        latestVersion: 1,
      });
      const assignmentVersionId = await ctx.db.insert("assignmentVersions", {
        organizationId,
        assignmentId,
        version: 1,
        instructions: "Normalize values",
        language: "python",
        runtimeVersion: "3.12.0",
        entrypoint: "main.py",
        createdBy: teacherId,
        createdAt: 1,
      });
      return { organizationId, teacherId, studentId, courseId, assignmentId, assignmentVersionId };
    }

    const north = await organization("north");
    const south = await organization("south");
    const secondTeacherId = await ctx.db.insert("users", {
      organizationId: north.organizationId,
      authUserId: "second-teacher",
      username: "second-teacher",
      displayName: "Second Teacher",
      role: "teacher",
    });
    await ctx.db.insert("users", {
      organizationId: north.organizationId,
      authUserId: "unrelated-teacher",
      username: "unrelated-teacher",
      displayName: "Unrelated Teacher",
      role: "teacher",
    });
    const secondStudentId = await ctx.db.insert("users", {
      organizationId: north.organizationId,
      authUserId: "second-student",
      username: "second-student",
      displayName: "Second Student",
      role: "student",
    });

    async function submission(input: {
      organizationId: Id<"organizations">;
      courseId: Id<"courses">;
      assignmentId: Id<"assignments">;
      assignmentVersionId: Id<"assignmentVersions">;
      teacherId: Id<"users">;
      studentId: Id<"users">;
      suffix: string;
    }) {
      const classroomId = await ctx.db.insert("classrooms", {
        organizationId: input.organizationId,
        courseId: input.courseId,
        name: `Period ${input.suffix}`,
      });
      await ctx.db.insert("classroomTeachers", {
        organizationId: input.organizationId,
        classroomId,
        teacherId: input.teacherId,
      });
      const assignmentReleaseId = await ctx.db.insert("assignmentReleases", {
        organizationId: input.organizationId,
        classroomId,
        assignmentId: input.assignmentId,
        assignmentVersionId: input.assignmentVersionId,
        points: 10,
        order: 0,
        createdBy: input.teacherId,
        createdAt: 1,
      });
      const workspaceId = await ctx.db.insert("workspaces", {
        organizationId: input.organizationId,
        assignmentReleaseId,
        assignmentVersionId: input.assignmentVersionId,
        studentId: input.studentId,
        files: [],
        createdAt: 1,
        updatedAt: 1,
      });
      const snapshotId = await ctx.db.insert("submissionSnapshots", {
        organizationId: input.organizationId,
        workspaceId,
        assignmentVersionId: input.assignmentVersionId,
        historySequence: 12,
        objectKey: `${input.suffix}.gz`,
        contentHash: input.suffix.padEnd(64, "0"),
        byteLength: 1,
        files: [],
        createdAt: 1,
      });
      const submissionId = await ctx.db.insert("submissions", {
        organizationId: input.organizationId,
        workspaceId,
        assignmentReleaseId,
        assignmentVersionId: input.assignmentVersionId,
        studentId: input.studentId,
        snapshotId,
        idempotencyKey: input.suffix,
        attemptNumber: 1,
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
        proposedPoints: 0,
        submittedAt: 1,
      });
      return { classroomId, workspaceId, submissionId };
    }

    const first = await submission({ ...north, suffix: "first" });
    const second = await submission({
      ...north,
      teacherId: secondTeacherId,
      studentId: secondStudentId,
      suffix: "second",
    });
    const foreign = await submission({ ...south, suffix: "foreign" });
    return { north, south, secondTeacherId, secondStudentId, first, second, foreign };
  });
}

const matchedSpans = [
  {
    path: "main.py",
    start: 20,
    end: 75,
    relatedPath: "helpers.py",
    relatedStart: 4,
    relatedEnd: 59,
    text: "maximum = max(scores)\nreturn [score / maximum for score in scores]",
  },
];

describe("Similarity Signals", () => {
  it("plans comparisons only for the same Organization and Assignment Version", async () => {
    const backend = convexTest(schema, modules);
    const data = await seed(backend);
    const plan = await backend.query(internal.submissions.similarityPlan, {
      submissionId: data.second.submissionId,
    });

    expect(
      plan.candidates.map(({ submission }: { submission: Doc<"submissions"> }) => submission._id),
    ).toEqual([data.first.submissionId]);
    expect(
      plan.candidates.map(({ submission }: { submission: Doc<"submissions"> }) => submission._id),
    ).not.toContain(data.foreign.submissionId);
    await expect(
      backend.mutation(internal.integritySignals.recordSimilarity, {
        submissionId: data.second.submissionId,
        relatedSubmissionId: data.foreign.submissionId,
        matchedSpans,
      }),
    ).rejects.toThrow("scope is invalid");
  });

  it("exposes identities, exact spans, and related provenance to either responsible Teacher", async () => {
    const backend = convexTest(schema, modules);
    const data = await seed(backend);
    const signalId = await backend.mutation(internal.integritySignals.recordSimilarity, {
      submissionId: data.second.submissionId,
      relatedSubmissionId: data.first.submissionId,
      matchedSpans,
    });
    if (!signalId) throw new Error("Expected Similarity Signal");

    for (const subject of ["north-teacher", "second-teacher"]) {
      const evidence = await backend
        .withIdentity({ subject })
        .action(api.integritySignalEvidence.inspect, { signalId });
      expect(evidence.similarity).toMatchObject({
        students: expect.arrayContaining([
          expect.objectContaining({ username: "student" }),
          expect.objectContaining({ username: "second-student" }),
        ]),
        matchedSpans,
        provenance: expect.arrayContaining([
          expect.objectContaining({ submissionId: data.first.submissionId, historySequence: 12 }),
          expect.objectContaining({ submissionId: data.second.submissionId, historySequence: 12 }),
        ]),
      });
      expect(evidence).not.toHaveProperty("workspace");
      expect(evidence).not.toHaveProperty("files");
    }

    const relatedList = await backend
      .withIdentity({ subject: "north-teacher" })
      .query(api.integritySignals.listForWorkspace, { workspaceId: data.first.workspaceId });
    expect(relatedList.map(({ _id }: Doc<"integritySignals">) => _id)).toContain(signalId);
  });

  it("does not broaden evidence access and uses the common neutral review lifecycle", async () => {
    const backend = convexTest(schema, modules);
    const data = await seed(backend);
    const signalId = await backend.mutation(internal.integritySignals.recordSimilarity, {
      submissionId: data.second.submissionId,
      relatedSubmissionId: data.first.submissionId,
      matchedSpans,
    });
    if (!signalId) throw new Error("Expected Similarity Signal");

    await expect(
      backend
        .withIdentity({ subject: "unrelated-teacher" })
        .action(api.integritySignalEvidence.inspect, { signalId }),
    ).rejects.toThrow("Forbidden");
    await expect(
      backend
        .withIdentity({ subject: "south-teacher" })
        .action(api.integritySignalEvidence.inspect, { signalId }),
    ).rejects.toThrow("Forbidden");
    await backend
      .withIdentity({ subject: "second-teacher" })
      .mutation(api.integritySignals.review, {
        signalId,
        state: "dismissed",
        note: "Shared helper was discussed by the Teachers.",
      });
    const signal = await backend.run(async (ctx) => await ctx.db.get(signalId));
    expect(signal).toMatchObject({ type: "similarity", state: "dismissed" });
    expect(signal).not.toHaveProperty("cheating");
    expect(signal).not.toHaveProperty("misconduct");
    expect(signal).not.toHaveProperty("risk");
  });

  it("keeps archived similarity evidence readable but makes either related Classroom read-only", async () => {
    const backend = convexTest(schema, modules);
    const data = await seed(backend);
    const signalId = await backend.mutation(internal.integritySignals.recordSimilarity, {
      submissionId: data.first.submissionId,
      relatedSubmissionId: data.second.submissionId,
      matchedSpans,
    });
    if (!signalId) throw new Error("Expected Similarity Signal");

    await backend
      .withIdentity({ subject: "second-teacher" })
      .mutation(api.archive.archiveClassroom, { classroomId: data.second.classroomId });

    const teacher = backend.withIdentity({ subject: "north-teacher" });
    await expect(
      teacher.action(api.integritySignalEvidence.inspect, { signalId }),
    ).resolves.toMatchObject({ similarity: { matchedSpans } });
    await expect(
      teacher.query(api.integritySignals.listForWorkspace, {
        workspaceId: data.first.workspaceId,
      }),
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ _id: signalId })]));
    await expect(
      teacher.mutation(api.integritySignals.review, {
        signalId,
        state: "dismissed",
      }),
    ).rejects.toThrow("read-only");
  });
});
