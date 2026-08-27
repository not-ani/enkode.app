import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

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

async function seed(
  backend: ReturnType<typeof convexTest>,
  language: "python" | "java" = "python",
) {
  return await backend.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", { name: "North", slug: "north" });
    const studentId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-student",
      username: "student",
      displayName: "Student",
      role: "student",
    });
    const teacherId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-teacher",
      username: "teacher",
      displayName: "Teacher",
      role: "teacher",
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
      language,
      runtimeVersion: language === "java" ? "15.0.2" : "3.12.0",
      entrypoint: language === "java" ? "Main.java" : "main.py",
      createdBy: teacherId,
      createdAt: 1,
    });
    const hiddenTestId = await ctx.db.insert("evaluationTests", {
      organizationId,
      assignmentVersionId,
      name: "Secret edge",
      kind: language === "java" ? "java_harness" : "input_output",
      visibility: "hidden",
      weight: 3,
      stdin: language === "java" ? undefined : "secret input",
      expectedOutput: language === "java" ? undefined : "secret output",
      harness: language === "java" ? "    Main.greet();" : undefined,
      failGuidance: "Try an empty value.",
      order: 0,
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
    const files =
      language === "java"
        ? [
            {
              path: "Main.java",
              content:
                'public class Main { static void greet() { System.out.println("hello"); } public static void main(String[] args) { greet(); } }\n',
            },
          ]
        : [
            { path: "main.py", content: "from helper import answer\nprint(answer)\n" },
            { path: "helper.py", content: "answer = 42\n" },
          ];
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
      studentId,
      assignmentReleaseId,
      assignmentVersionId,
      hiddenTestId,
      workspaceId,
      files,
    };
  });
}

describe("immutable Submission attempts", () => {
  it("creates one attempt when an explicit Submit action is retried", async () => {
    const backend = convexTest(schema, modules);
    const seeded = await seed(backend);
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
    const requests: { url: string; contentType: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        requests.push({ url: String(input), contentType: headers.get("content-type") ?? "" });
        if ((init?.method ?? "GET") === "GET") return new Response(historySnapshot);
        if (headers.get("content-type") === "application/gzip") return new Response(null);
        return new Response(
          JSON.stringify({ run: { stdout: "wrong", stderr: "", code: 0, signal: null } }),
        );
      }),
    );
    process.env.ENKODE_EXECUTION_ENDPOINT = "https://execute.example.test";
    process.env.ENKODE_OBJECT_STORAGE_ENDPOINT = "https://objects.example.test";
    process.env.ENKODE_OBJECT_STORAGE_BUCKET = "enkode";
    process.env.ENKODE_OBJECT_STORAGE_REGION = "auto";
    process.env.ENKODE_OBJECT_STORAGE_ACCESS_KEY_ID = "access";
    process.env.ENKODE_OBJECT_STORAGE_SECRET_ACCESS_KEY = "secret";
    const student = backend.withIdentity({ subject: "auth-student" });
    const input = {
      workspaceId: seeded.workspaceId,
      files: seeded.files,
      requiredHistorySequence: 1,
      idempotencyKey: "one-explicit-click",
    };

    const first = await student.action(api.submissionUpload.submit, input);
    const retry = await student.action(api.submissionUpload.submit, input);

    expect(retry._id).toBe(first._id);
    expect(requests.filter(({ contentType }) => contentType === "application/gzip")).toHaveLength(
      1,
    );
    expect(requests.filter(({ url }) => url.includes("/api/v2/execute"))).toHaveLength(2);
    expect(await backend.run(async (ctx) => ctx.db.query("submissions").collect())).toHaveLength(1);
  });

  it("submits Java with the exact runtime while redacting hidden harness details", async () => {
    const backend = convexTest(schema, modules);
    const seeded = await seed(backend, "java");
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
      contentHash: "java-history-hash",
      objectKey: "history/java-1.gz",
      byteLength: 1,
      snapshotHash: historySnapshotHash,
      snapshotObjectKey: "snapshots/java-1.gz",
      snapshotByteLength: historySnapshot.byteLength,
    });
    const executionRequests: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if ((init?.method ?? "GET") === "GET") return new Response(historySnapshot);
        if (headers.get("content-type") === "application/gzip") return new Response(null);
        executionRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ run: { stdout: "hello\n", stderr: "", code: 0, signal: null } }),
        );
      }),
    );
    process.env.ENKODE_EXECUTION_ENDPOINT = "https://execute.example.test";
    process.env.ENKODE_OBJECT_STORAGE_ENDPOINT = "https://objects.example.test";
    process.env.ENKODE_OBJECT_STORAGE_BUCKET = "enkode";
    process.env.ENKODE_OBJECT_STORAGE_REGION = "auto";
    process.env.ENKODE_OBJECT_STORAGE_ACCESS_KEY_ID = "access";
    process.env.ENKODE_OBJECT_STORAGE_SECRET_ACCESS_KEY = "secret";

    const result = await backend
      .withIdentity({ subject: "auth-student" })
      .action(api.submissionUpload.submit, {
        workspaceId: seeded.workspaceId,
        files: seeded.files,
        requiredHistorySequence: 1,
        idempotencyKey: "java-submit",
      });

    expect(executionRequests).toHaveLength(2);
    expect(executionRequests.every(({ language }) => language === "java")).toBe(true);
    expect(executionRequests.every(({ version }) => version === "15.0.2")).toBe(true);
    expect(result).toMatchObject({
      language: "java",
      runtimeVersion: "15.0.2",
      testResults: [{ visibility: "hidden", weight: 3, passed: true }],
    });
    expect(JSON.stringify(result)).not.toContain("__enkode_hidden_test_0");
    expect(JSON.stringify(result)).not.toContain("Main.greet");
  });

  it("rejects files that do not match the acknowledged Work History snapshot", async () => {
    const backend = convexTest(schema, modules);
    const seeded = await seed(backend);
    const historySnapshot = gzipSync(
      JSON.stringify({
        version: 1,
        workspaceId: seeded.workspaceId,
        sequence: 1,
        files: [{ path: "main.py", content: "different history" }],
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(historySnapshot)),
    );
    process.env.ENKODE_EXECUTION_ENDPOINT = "https://execute.example.test";
    process.env.ENKODE_OBJECT_STORAGE_ENDPOINT = "https://objects.example.test";
    process.env.ENKODE_OBJECT_STORAGE_BUCKET = "enkode";
    process.env.ENKODE_OBJECT_STORAGE_REGION = "auto";
    process.env.ENKODE_OBJECT_STORAGE_ACCESS_KEY_ID = "access";
    process.env.ENKODE_OBJECT_STORAGE_SECRET_ACCESS_KEY = "secret";

    await expect(
      backend.withIdentity({ subject: "auth-student" }).action(api.submissionUpload.submit, {
        workspaceId: seeded.workspaceId,
        files: seeded.files,
        requiredHistorySequence: 1,
        idempotencyKey: "mismatched-history",
      }),
    ).rejects.toThrow("Finalized Work History does not match");
    expect(await backend.run(async (ctx) => ctx.db.query("submissions").collect())).toEqual([]);
  });

  it("requires acknowledged history, keeps snapshots immutable, redacts hidden data, and retries idempotently", async () => {
    const backend = convexTest(schema, modules);
    const seeded = await seed(backend);
    const student = backend.withIdentity({ subject: "auth-student" });
    const prepare = {
      workspaceId: seeded.workspaceId,
      files: seeded.files,
      requiredHistorySequence: 1,
      idempotencyKey: "stable-retry-key",
    };

    await expect(student.query(internal.submissions.prepare, prepare)).rejects.toThrow(
      "not durably acknowledged",
    );
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
      snapshotHash: "snapshot-hash",
      snapshotObjectKey: "snapshots/1.gz",
      snapshotByteLength: 1,
    });
    await expect(student.query(internal.submissions.prepare, prepare)).resolves.toMatchObject({
      assignmentVersionId: seeded.assignmentVersionId,
      requiredHistorySequence: 1,
    });

    const record = {
      workspaceId: seeded.workspaceId,
      organizationId: seeded.organizationId,
      studentId: seeded.studentId,
      assignmentReleaseId: seeded.assignmentReleaseId,
      assignmentVersionId: seeded.assignmentVersionId,
      runtimeVersion: "3.12.0",
      entrypoint: "main.py",
      historySequence: 1,
      idempotencyKey: "stable-retry-key",
      snapshot: {
        objectKey: "submissions/snapshot.gz",
        contentHash: "submission-hash",
        byteLength: 100,
        files: seeded.files.map(({ path, content }) => ({
          path,
          contentHash: `hash-${content.length}`,
          byteLength: content.length,
        })),
      },
      execution: {
        status: "completed" as const,
        stdout: "42\n",
        stderr: "",
        exitCode: 0,
        signal: null,
      },
      testResults: [
        {
          evaluationTestId: seeded.hiddenTestId,
          name: "Secret edge",
          visibility: "hidden" as const,
          weight: 3,
          passed: false,
          guidance: "Try an empty value.",
          stdout: "sensitive actual output",
          stderr: "sensitive traceback",
          exitCode: 1,
        },
      ],
      proposedPoints: 0,
    };
    const first = await student.mutation(internal.submissions.record, record);
    const retry = await student.mutation(internal.submissions.record, record);
    expect(retry._id).toBe(first._id);
    expect(await backend.run(async (ctx) => ctx.db.query("submissions").collect())).toHaveLength(1);
    expect(
      await backend.run(async (ctx) => ctx.db.query("submissionSnapshots").collect()),
    ).toHaveLength(1);

    await backend.run(async (ctx) => {
      await ctx.db.patch(seeded.workspaceId, {
        files: seeded.files.map((file) => ({ ...file, content: "changed later" })),
      });
    });
    const snapshot = await backend.run(async (ctx) => ctx.db.query("submissionSnapshots").first());
    expect(snapshot).toMatchObject({
      assignmentVersionId: seeded.assignmentVersionId,
      historySequence: 1,
      files: record.snapshot.files,
    });

    const mine = await student.query(api.submissions.mine, { workspaceId: seeded.workspaceId });
    expect(mine[0]).toMatchObject({ attemptNumber: 1, current: true });
    expect(mine[0].testResults[0]).toEqual({
      visibility: "hidden",
      weight: 3,
      passed: false,
      guidance: "Try an empty value.",
    });
    expect(JSON.stringify(mine)).not.toContain("sensitive");
    expect(JSON.stringify(mine)).not.toContain("secret input");

    const teacher = backend.withIdentity({ subject: "auth-teacher" });
    const teacherAttempts = await teacher.query(api.submissions.forTeacher, {
      assignmentReleaseId: seeded.assignmentReleaseId,
      studentId: seeded.studentId,
    });
    expect(teacherAttempts[0]?.testResults[0]).toMatchObject({
      name: "Secret edge",
      stdout: "sensitive actual output",
    });
  });

  it("retains every unlimited attempt and marks the newest current", async () => {
    const backend = convexTest(schema, modules);
    const seeded = await seed(backend);
    const student = backend.withIdentity({ subject: "auth-student" });
    const base = {
      workspaceId: seeded.workspaceId,
      organizationId: seeded.organizationId,
      studentId: seeded.studentId,
      assignmentReleaseId: seeded.assignmentReleaseId,
      assignmentVersionId: seeded.assignmentVersionId,
      runtimeVersion: "3.12.0",
      entrypoint: "main.py",
      historySequence: 1,
      snapshot: {
        objectKey: "snapshot",
        contentHash: "hash",
        byteLength: 1,
        files: [{ path: "main.py", contentHash: "hash", byteLength: 1 }],
      },
      execution: {
        status: "completed" as const,
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
      },
      testResults: [],
      proposedPoints: 0,
    };
    await student.mutation(internal.submissions.record, { ...base, idempotencyKey: "attempt-1" });
    await student.mutation(internal.submissions.record, { ...base, idempotencyKey: "attempt-2" });
    const attempts = await student.query(api.submissions.mine, { workspaceId: seeded.workspaceId });
    expect(
      attempts.map((attempt: { attemptNumber: number; current: boolean }) => ({
        attemptNumber: attempt.attemptNumber,
        current: attempt.current,
      })),
    ).toEqual([
      { attemptNumber: 2, current: true },
      { attemptNumber: 1, current: false },
    ]);
  });
});
