import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { AssignmentLanguage } from "./runtimeCatalog";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const cases = [
  { language: "javascript", version: "22.14.0", entrypoint: "main.js" },
  { language: "typescript", version: "5.0.3", entrypoint: "main.ts" },
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of [
    "ENKODE_EXECUTION_ENDPOINT",
    "ENKODE_OBJECT_STORAGE_ENDPOINT",
    "ENKODE_OBJECT_STORAGE_BUCKET",
    "ENKODE_OBJECT_STORAGE_REGION",
    "ENKODE_OBJECT_STORAGE_ACCESS_KEY_ID",
    "ENKODE_OBJECT_STORAGE_SECRET_ACCESS_KEY",
  ]) {
    delete process.env[name];
  }
});

describe.each(cases)("$language backend workflow", ({ language, version, entrypoint }) => {
  it("Runs public tests and explicitly Submits public and hidden tests on the exact runtime", async () => {
    const backend = convexTest(schema, modules);
    const seeded = await seed(backend, language, version, entrypoint);
    const historySnapshot = gzipSync(
      JSON.stringify({
        version: 1,
        workspaceId: seeded.workspaceId,
        sequence: 1,
        files: seeded.files,
      }),
    );
    const historySnapshotHash = createHash("sha256").update(historySnapshot).digest("hex");
    await backend.mutation(internal.workHistory.commitChunk, {
      workspaceId: seeded.workspaceId,
      organizationId: seeded.organizationId,
      studentId: seeded.studentId,
      startSequence: 1,
      endSequence: 1,
      eventCount: 1,
      contentHash: "history-hash",
      objectKey: "history/1.gz",
      byteLength: 1,
      snapshotHash: historySnapshotHash,
      snapshotObjectKey: "snapshots/1.gz",
      snapshotByteLength: historySnapshot.byteLength,
    });

    const executions: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if ((init?.method ?? "GET") === "GET") return new Response(historySnapshot);
        if (headers.get("content-type") === "application/gzip") return new Response(null);
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        executions.push(request);
        const stdout = request.stdin === "secret" ? "secret output" : "ok\n";
        return new Response(JSON.stringify({ run: { stdout, stderr: "", code: 0, signal: null } }));
      }),
    );
    process.env.ENKODE_EXECUTION_ENDPOINT = "https://execute.example.test";
    process.env.ENKODE_OBJECT_STORAGE_ENDPOINT = "https://objects.example.test";
    process.env.ENKODE_OBJECT_STORAGE_BUCKET = "enkode";
    process.env.ENKODE_OBJECT_STORAGE_REGION = "auto";
    process.env.ENKODE_OBJECT_STORAGE_ACCESS_KEY_ID = "access";
    process.env.ENKODE_OBJECT_STORAGE_SECRET_ACCESS_KEY = "secret";
    const student = backend.withIdentity({ subject: "auth-student" });

    const run = await student.action(api.runs.run, {
      workspaceId: seeded.workspaceId,
      files: seeded.files,
    });
    expect(run.publicTestResults).toEqual([
      expect.objectContaining({ name: "Public", passed: true }),
    ]);
    expect(executions).toHaveLength(2);
    expect(JSON.stringify(executions)).not.toContain("secret");

    const submission = await student.action(api.submissionUpload.submit, {
      workspaceId: seeded.workspaceId,
      files: seeded.files,
      requiredHistorySequence: 1,
      idempotencyKey: `${language}-attempt-1`,
    });
    expect(submission).toMatchObject({
      attemptNumber: 1,
      proposedPoints: 3,
      testResults: [
        { visibility: "public", passed: true },
        { visibility: "hidden", passed: true, guidance: "Hidden behavior works." },
      ],
    });
    expect(executions).toHaveLength(5);
    expect(executions.every((request) => request.language === language)).toBe(true);
    expect(executions.every((request) => request.version === version)).toBe(true);
    expect(executions.every((request) => (request.files as { name: string }[])[0]?.name)).toBe(
      true,
    );
    expect(JSON.stringify(submission)).not.toContain("secret output");
    expect(JSON.stringify(submission)).not.toContain("secret");
    const submissionId = submission._id as Id<"submissions">;
    expect(await backend.run((ctx) => ctx.db.get(submissionId))).toMatchObject({
      assignmentVersionId: seeded.assignmentVersionId,
      runtimeVersion: version,
      snapshotId: expect.any(String),
    });
    expect(
      await backend.run(async (ctx) => {
        const stored = await ctx.db.get(submissionId);
        return stored ? await ctx.db.get(stored.snapshotId) : null;
      }),
    ).toMatchObject({
      assignmentVersionId: seeded.assignmentVersionId,
      historySequence: 1,
    });
  });

  it("composes Deadline, adoption, and archive policies without losing its runtime", async () => {
    const backend = convexTest(schema, modules);
    const seeded = await seed(backend, language, version, entrypoint);
    const teacher = backend.withIdentity({ subject: "auth-teacher" });
    const student = backend.withIdentity({ subject: "auth-student" });

    await teacher.mutation(api.assignmentReleases.configureSubmissionPolicy, {
      assignmentReleaseId: seeded.assignmentReleaseId,
      deadlinePolicy: "hard_close",
      deadlineAt: Date.now() - 1,
    });
    await expect(
      student.query(api.assignmentReleases.open, {
        assignmentReleaseId: seeded.assignmentReleaseId,
      }),
    ).resolves.toMatchObject({
      language,
      runtimeVersion: version,
      submissionEligibility: { canSubmit: false },
      deadlineFacts: { missing: true },
    });

    const nextVersionId = await teacher.mutation(api.assignments.createVersion, {
      assignmentId: seeded.assignmentId,
      language,
      instructions: "Print updated output",
      runtimeVersion: version,
      entrypoint,
      starterFiles: [{ path: entrypoint, content: "console.log('updated')\n" }],
      evaluationTests: [],
    });
    await teacher.mutation(api.assignmentReleases.adoptVersion, {
      assignmentReleaseId: seeded.assignmentReleaseId,
      assignmentVersionId: nextVersionId,
    });
    await expect(
      student.query(api.assignmentReleases.open, {
        assignmentReleaseId: seeded.assignmentReleaseId,
      }),
    ).resolves.toMatchObject({
      assignmentVersionId: nextVersionId,
      language,
      runtimeVersion: version,
    });
    await expect(
      student.mutation(api.workspaces.open, {
        assignmentReleaseId: seeded.assignmentReleaseId,
      }),
    ).resolves.toMatchObject({
      assignmentVersionId: seeded.assignmentVersionId,
      language,
      runtimeVersion: version,
      versionMerge: {
        fromAssignmentVersionId: seeded.assignmentVersionId,
        toAssignmentVersionId: nextVersionId,
      },
    });

    await teacher.mutation(api.archive.archiveAssignment, { assignmentId: seeded.assignmentId });
    await expect(
      teacher.mutation(api.assignments.createVersion, {
        assignmentId: seeded.assignmentId,
        language,
        instructions: "Archived change",
        runtimeVersion: version,
        entrypoint,
        starterFiles: [{ path: entrypoint, content: "" }],
        evaluationTests: [],
      }),
    ).rejects.toThrow("read-only");
    await expect(
      teacher.mutation(api.assignmentReleases.configureSubmissionPolicy, {
        assignmentReleaseId: seeded.assignmentReleaseId,
        deadlinePolicy: "no_deadline",
      }),
    ).rejects.toThrow("read-only");
    await expect(
      student.query(api.assignmentReleases.open, {
        assignmentReleaseId: seeded.assignmentReleaseId,
      }),
    ).resolves.toMatchObject({ language, runtimeVersion: version });
  });
});

async function seed(
  backend: ReturnType<typeof convexTest>,
  language: AssignmentLanguage,
  runtimeVersion: string,
  entrypoint: string,
) {
  return await backend.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", { name: "North", slug: "north" });
    const teacherId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-teacher",
      username: "teacher",
      displayName: "Teacher",
      role: "teacher",
    });
    const studentId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-student",
      username: "student",
      displayName: "Student",
      role: "student",
    });
    const courseId = await ctx.db.insert("courses", { organizationId, name: "CS101" });
    await ctx.db.insert("courseCollaborators", { organizationId, courseId, teacherId });
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
      title: language,
      latestVersion: 1,
    });
    const assignmentVersionId = await ctx.db.insert("assignmentVersions", {
      organizationId,
      assignmentId,
      version: 1,
      instructions: "Print output",
      language,
      runtimeVersion,
      entrypoint,
      createdBy: teacherId,
      createdAt: 1,
    });
    await ctx.db.insert("assignmentStarterFiles", {
      organizationId,
      assignmentVersionId,
      path: entrypoint,
      content: "console.log('ok')\n",
      order: 0,
    });
    await ctx.db.insert("evaluationTests", {
      organizationId,
      assignmentVersionId,
      name: "Public",
      kind: "input_output",
      visibility: "public",
      weight: 1,
      stdin: "",
      expectedOutput: "ok\n",
      order: 0,
    });
    await ctx.db.insert("evaluationTests", {
      organizationId,
      assignmentVersionId,
      name: "Hidden",
      kind: "input_output",
      visibility: "hidden",
      weight: 2,
      stdin: "secret",
      expectedOutput: "secret output",
      passGuidance: "Hidden behavior works.",
      order: 1,
    });
    const assignmentReleaseId = await ctx.db.insert("assignmentReleases", {
      organizationId,
      classroomId,
      assignmentId,
      assignmentVersionId,
      points: 3,
      order: 0,
      publicationState: "published",
      publishedAt: 1,
      createdBy: teacherId,
      createdAt: 1,
    });
    const files = [{ path: entrypoint, content: "console.log('ok')\n" }];
    const workspaceId = await ctx.db.insert("workspaces", {
      organizationId,
      assignmentReleaseId,
      assignmentVersionId,
      studentId,
      files,
      historyAckSequence: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    return {
      organizationId,
      assignmentId,
      assignmentReleaseId,
      assignmentVersionId,
      studentId,
      workspaceId,
      files,
    };
  });
}
