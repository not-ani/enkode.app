import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import betterAuthTest from "@convex-dev/better-auth/test";
import Ajv2020 from "ajv/dist/2020.js";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it } from "vitest";

import { internal } from "./_generated/api";
import { FakeObjectStorage } from "./objectStorage";
import { buildOrganizationExport } from "./organizationExport";
import {
  organizationExportRecordNames,
  organizationExportV1Schema,
} from "./organizationExportFormat";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const documentedSchema = JSON.parse(
  readFileSync(
    new URL("../../../docs/internals/organization-export-v1.schema.json", import.meta.url),
    "utf8",
  ),
);

function backend() {
  const test = convexTest(schema, modules);
  betterAuthTest.register(test);
  return test;
}

function immutable(key: string, text: string, contentType: string) {
  const bytes = new TextEncoder().encode(text);
  return {
    key,
    bytes,
    contentType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function seed(test: ReturnType<typeof backend>) {
  const attachment = immutable("north/materials/guide.pdf", "%PDF guide", "application/pdf");
  const history = immutable("north/history/1.gz", "history", "application/gzip");
  const historySnapshot = immutable("north/history/snapshot-1.gz", "workspace", "application/gzip");
  const submissionSnapshot = immutable(
    "north/submissions/attempt-1.json",
    '{"files":[]}',
    "application/json",
  );
  const ids = await test.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", { name: "North", slug: "north" });
    const otherOrganizationId = await ctx.db.insert("organizations", {
      name: "South",
      slug: "south",
    });
    const teacherId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "north-teacher",
      username: "teacher",
      displayName: "Teacher",
      role: "teacher",
    });
    const studentId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "north-student",
      username: "student",
      displayName: "Student",
      role: "student",
    });
    await ctx.db.insert("users", {
      organizationId: otherOrganizationId,
      authUserId: "south-teacher",
      username: "teacher",
      displayName: "Other Teacher",
      role: "teacher",
    });
    const courseId = await ctx.db.insert("courses", {
      organizationId,
      name: "Archived CS101",
      archivedAt: 50,
      archivedBy: teacherId,
    });
    await ctx.db.insert("courseCollaborators", { organizationId, courseId, teacherId });
    const classroomId = await ctx.db.insert("classrooms", {
      organizationId,
      courseId,
      name: "Period 1",
      archivedAt: 51,
      archivedBy: teacherId,
    });
    await ctx.db.insert("classroomTeachers", { organizationId, classroomId, teacherId });
    await ctx.db.insert("enrollments", {
      organizationId,
      classroomId,
      studentId,
      status: "ended",
      endedAt: 52,
    });
    const assignmentId = await ctx.db.insert("assignments", {
      organizationId,
      courseId,
      title: "Hello",
      latestVersion: 5,
      archivedAt: 53,
      archivedBy: teacherId,
    });
    const firstVersionId = await ctx.db.insert("assignmentVersions", {
      organizationId,
      assignmentId,
      version: 1,
      instructions: "Old instructions",
      language: "python",
      runtimeVersion: "3.12.0",
      entrypoint: "main.py",
      createdBy: teacherId,
      createdAt: 1,
    });
    await ctx.db.insert("assignmentVersions", {
      organizationId,
      assignmentId,
      version: 2,
      instructions: "New instructions",
      language: "python",
      runtimeVersion: "3.12.1",
      entrypoint: "main.py",
      createdBy: teacherId,
      createdAt: 2,
    });
    for (const [version, language, runtimeVersion, entrypoint] of [
      [3, "javascript", "22.14.0", "main.js"],
      [4, "typescript", "5.0.3", "main.ts"],
      [5, "java", "15.0.2", "Main.java"],
    ] as const) {
      await ctx.db.insert("assignmentVersions", {
        organizationId,
        assignmentId,
        version,
        instructions: `${language} instructions`,
        language,
        runtimeVersion,
        entrypoint,
        createdBy: teacherId,
        createdAt: version,
      });
    }
    await ctx.db.insert("assignmentStarterFiles", {
      organizationId,
      assignmentVersionId: firstVersionId,
      path: "main.py",
      content: "print('hello')",
      order: 0,
    });
    const evaluationTestId = await ctx.db.insert("evaluationTests", {
      organizationId,
      assignmentVersionId: firstVersionId,
      name: "prints hello",
      kind: "input_output",
      visibility: "public",
      weight: 10,
      expectedOutput: "hello",
      order: 0,
    });
    const assignmentReleaseId = await ctx.db.insert("assignmentReleases", {
      organizationId,
      classroomId,
      assignmentId,
      assignmentVersionId: firstVersionId,
      points: 10,
      order: 0,
      publicationState: "published",
      publishedAt: 3,
      createdBy: teacherId,
      createdAt: 3,
    });
    const workspaceId = await ctx.db.insert("workspaces", {
      organizationId,
      assignmentReleaseId,
      assignmentVersionId: firstVersionId,
      studentId,
      files: [{ path: "main.py", content: "print('hello')" }],
      historyAckSequence: 1,
      createdAt: 4,
      updatedAt: 5,
    });
    await ctx.db.insert("runs", {
      organizationId,
      workspaceId,
      assignmentReleaseId,
      assignmentVersionId: firstVersionId,
      studentId,
      runtimeVersion: "3.12.0",
      entrypoint: "main.py",
      files: [{ path: "main.py", content: "print('hello')" }],
      execution: { status: "completed", stdout: "hello", stderr: "", exitCode: 0, signal: null },
      publicTestResults: [
        {
          evaluationTestId,
          name: "prints hello",
          passed: true,
          stdout: "hello",
          stderr: "",
          exitCode: 0,
        },
      ],
      completedAt: 6,
    });
    await ctx.db.insert("workHistoryChunks", {
      organizationId,
      workspaceId,
      studentId,
      startSequence: 1,
      endSequence: 1,
      eventCount: 1,
      contentHash: history.sha256,
      objectKey: history.key,
      byteLength: history.bytes.byteLength,
      encoding: "gzip-json-v1",
      snapshotHash: historySnapshot.sha256,
      snapshotObjectKey: historySnapshot.key,
      snapshotByteLength: historySnapshot.bytes.byteLength,
      committedAt: 6,
    });
    const snapshotId = await ctx.db.insert("submissionSnapshots", {
      organizationId,
      workspaceId,
      assignmentVersionId: firstVersionId,
      historySequence: 1,
      objectKey: submissionSnapshot.key,
      contentHash: submissionSnapshot.sha256,
      byteLength: submissionSnapshot.bytes.byteLength,
      files: [],
      createdAt: 7,
    });
    const submissionId = await ctx.db.insert("submissions", {
      organizationId,
      workspaceId,
      assignmentReleaseId,
      assignmentVersionId: firstVersionId,
      studentId,
      snapshotId,
      idempotencyKey: "attempt-1",
      attemptNumber: 1,
      runtimeVersion: "3.12.0",
      entrypoint: "main.py",
      execution: { status: "completed", stdout: "hello", stderr: "", exitCode: 0, signal: null },
      testResults: [],
      proposedPoints: 10,
      submittedAt: 8,
    });
    const gradeId = await ctx.db.insert("grades", {
      organizationId,
      assignmentReleaseId,
      studentId,
      submissionId,
      proposedPoints: 10,
      points: 9,
      overallFeedback: "Good work",
      inlineFeedback: [],
      updatedBy: teacherId,
      updatedAt: 9,
    });
    const gradeReturnId = await ctx.db.insert("gradeReturns", {
      organizationId,
      gradeId,
      assignmentReleaseId,
      studentId,
      submissionId,
      proposedPoints: 10,
      points: 9,
      overallFeedback: "Good work",
      inlineFeedback: [],
      revision: 1,
      returnedBy: teacherId,
      returnedAt: 10,
    });
    await ctx.db.patch(gradeId, { latestReturnId: gradeReturnId });
    await ctx.db.insert("notifications", {
      organizationId,
      recipientId: studentId,
      classroomId,
      type: "grade_returned",
      dedupeKey: `grade_returned:${gradeReturnId}`,
      title: "Grade returned",
      body: "Your grade is ready.",
      assignmentReleaseId,
      gradeReturnId,
      createdAt: 10,
      readAt: 11,
    });
    await ctx.db.insert("integritySignals", {
      organizationId,
      workspaceId,
      studentId,
      type: "large_paste",
      state: "reviewed",
      evidenceKey: "paste:1",
      createdAt: 8,
      reviewedBy: teacherId,
      reviewedAt: 9,
    });
    await ctx.db.insert("auditEvents", {
      organizationId,
      courseId,
      classroomId,
      actorKind: "user",
      actorUserId: teacherId,
      action: "grade.returned",
      targetKind: "grade_return",
      targetId: gradeReturnId,
      occurredAt: 1,
    });
    const attachmentId = await ctx.db.insert("materialAttachments", {
      organizationId,
      storageProvider: "fake",
      storageBucket: "memory",
      storageKey: attachment.key,
      filename: "guide.pdf",
      contentType: attachment.contentType,
      byteSize: attachment.bytes.byteLength,
      sha256: attachment.sha256,
      createdBy: teacherId,
      createdAt: 1,
    });
    const materialId = await ctx.db.insert("materials", {
      organizationId,
      courseId,
      title: "Guide",
      latestVersion: 1,
      archivedAt: 54,
      archivedBy: teacherId,
    });
    const materialVersionId = await ctx.db.insert("materialVersions", {
      organizationId,
      materialId,
      version: 1,
      kind: "file",
      attachmentId,
      createdBy: teacherId,
      createdAt: 2,
    });
    await ctx.db.insert("materialReleases", {
      organizationId,
      classroomId,
      materialId,
      materialVersionId,
      order: 0,
      publicationState: "published",
      publishedAt: 3,
      createdBy: teacherId,
      createdAt: 3,
    });
    return { classroomId, courseId, gradeId, gradeReturnId, organizationId, teacherId };
  });
  return { attachment, history, historySnapshot, ids, submissionSnapshot };
}

describe("Organization Export", () => {
  beforeEach(() => {
    process.env.SITE_URL = "http://localhost:3000";
    process.env.BETTER_AUTH_SECRET = "test-secret-that-is-at-least-32-characters";
    process.env.DEVELOPER_PROVISIONING_SECRET = "developer-test-secret";
  });

  it("exports a schema-valid, complete and isolated academic archive with every binary", async () => {
    const test = backend();
    const seeded = await seed(test);
    const storage = new FakeObjectStorage();
    for (const object of [
      seeded.attachment,
      seeded.history,
      seeded.historySnapshot,
      seeded.submissionSnapshot,
    ]) {
      await storage.putImmutable(object);
    }
    const snapshot = await test.query(internal.organizationExportRead.readOrganizationSnapshot, {
      organizationSlug: "north",
    });
    const first = await buildOrganizationExport(
      () => Promise.resolve(snapshot),
      storage,
      "2026-08-26T00:00:00.000Z",
    );
    const second = await buildOrganizationExport(
      () => Promise.resolve(snapshot),
      storage,
      "2026-08-26T00:00:00.000Z",
    );
    expect(second).toBe(first);

    const rawBundle = JSON.parse(first);
    const validator = new Ajv2020({ strict: true });
    validator.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
    const validates = validator.compile(documentedSchema);
    expect(validates(rawBundle), validates.errors?.map((error) => error.message).join(", ")).toBe(
      true,
    );
    const bundle = organizationExportV1Schema.parse(rawBundle);
    expect(Object.keys(bundle.records).sort()).toEqual([...organizationExportRecordNames].sort());
    expect(bundle.organization.slug).toBe("north");
    expect(bundle.records.users).toHaveLength(2);
    expect(bundle.records.users.map((user) => user.displayName)).not.toContain("Other Teacher");
    expect(bundle.records.courses[0]).toMatchObject({
      id: seeded.ids.courseId,
      archivedAt: 50,
    });
    expect(bundle.records.assignmentVersions.map((version) => version.version)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(bundle.records.assignmentVersions.map((version) => version.language)).toEqual([
      "python",
      "python",
      "javascript",
      "typescript",
      "java",
    ]);
    expect(bundle.records.grades[0]).toMatchObject({
      id: seeded.ids.gradeId,
      overallFeedback: "Good work",
    });
    expect(bundle.records.gradeReturns).toHaveLength(1);
    expect(bundle.records.notifications[0]).toMatchObject({
      type: "grade_returned",
      readAt: 11,
    });
    expect(bundle.records.runs).toHaveLength(1);
    expect(bundle.records.materialReleases).toHaveLength(1);
    expect(bundle.records.integritySignals).toHaveLength(1);
    expect(bundle.records.auditEvents[0]).toMatchObject({
      courseId: seeded.ids.courseId,
      classroomId: seeded.ids.classroomId,
      actorUserId: seeded.ids.teacherId,
      action: "grade.returned",
      targetKind: "grade_return",
      targetId: seeded.ids.gradeReturnId,
    });
    expect(bundle.objects).toHaveLength(4);
    expect(bundle.objects.map((object) => object.sha256).sort()).toEqual(
      [seeded.attachment, seeded.history, seeded.historySnapshot, seeded.submissionSnapshot]
        .map((object) => object.sha256)
        .sort(),
    );
  });

  it("requires developer authorization and exports exactly the requested Organization", async () => {
    const test = backend();
    await test.run(async (ctx) => {
      await ctx.db.insert("organizations", { name: "North", slug: "north" });
      await ctx.db.insert("organizations", { name: "South", slug: "south" });
    });
    const request = () =>
      test.fetch("/api/developer/export-organization", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationSlug: "north" }),
      });
    expect((await request()).status).toBe(404);
    const response = await test.fetch("/api/developer/export-organization", {
      method: "POST",
      headers: {
        authorization: "Bearer developer-test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ organizationSlug: "north" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("version=1");
    const bundle = organizationExportV1Schema.parse(await response.json());
    expect(bundle.organization.slug).toBe("north");
  });
});
