import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTestBackend() {
  return convexTest(schema, modules);
}

const richText = { kind: "rich_text" as const, richText: "Read **chapter one**." };
type MaterialReleaseSummary = { _id: Id<"materialReleases"> };

async function seedContext(backend: ReturnType<typeof createTestBackend>) {
  const ids = await backend.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      name: "North Academy",
      slug: "north",
    });
    const otherOrganizationId = await ctx.db.insert("organizations", {
      name: "South Academy",
      slug: "south",
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
      authUserId: "auth-unassigned",
      username: "unassigned",
      displayName: "Unassigned Teacher",
      role: "teacher",
    });
    await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-author-only",
      username: "author-only",
      displayName: "Course Collaborator",
      role: "teacher",
    });
    await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-classroom-only",
      username: "classroom-only",
      displayName: "Classroom Teacher",
      role: "teacher",
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
      authUserId: "auth-other-student",
      username: "other-student",
      displayName: "Other Student",
      role: "student",
    });
    await ctx.db.insert("users", {
      organizationId: otherOrganizationId,
      authUserId: "auth-other-org",
      username: "teacher",
      displayName: "Other Organization Teacher",
      role: "teacher",
    });
    return { organizationId, studentId, teacherId };
  });
  const teacher = backend.withIdentity({ subject: "auth-teacher" });
  const courseId = await teacher.mutation(api.courses.create, { name: "CS101" });
  const classroomId = await teacher.mutation(api.classrooms.create, {
    courseId,
    name: "Period 1",
  });
  await teacher.mutation(api.courses.addCollaborator, { courseId, username: "author-only" });
  await teacher.mutation(api.classrooms.addTeacher, { classroomId, username: "classroom-only" });
  const enrollmentId = await teacher.mutation(api.enrollments.enroll, {
    classroomId,
    studentId: ids.studentId,
  });
  return { ...ids, classroomId, courseId, enrollmentId, teacher };
}

describe("versioned Materials", () => {
  beforeEach(() => {
    vi.stubEnv("ENKODE_OBJECT_STORAGE_PROVIDER", "s3-compatible");
    vi.stubEnv("ENKODE_OBJECT_STORAGE_BUCKET", "enkode-test");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("creates rich-text and external-link Materials as immutable Versions", async () => {
    const backend = createTestBackend();
    const { courseId, teacher } = await seedContext(backend);
    const created = await teacher.mutation(api.materials.create, {
      courseId,
      title: "Getting started",
      content: richText,
    });
    const secondVersionId = await teacher.mutation(api.materials.createVersion, {
      materialId: created.materialId,
      content: { kind: "external_link", externalUrl: "https://example.com/reference" },
    });

    expect(
      await teacher.query(api.materials.getVersion, {
        materialVersionId: created.materialVersionId,
      }),
    ).toMatchObject({ version: 1, kind: "rich_text", richText: richText.richText });
    expect(
      await teacher.query(api.materials.getVersion, { materialVersionId: secondVersionId }),
    ).toMatchObject({
      version: 2,
      kind: "external_link",
      externalUrl: "https://example.com/reference",
    });
    const rows = await backend.run(async (ctx) =>
      ctx.db
        .query("materialVersions")
        .withIndex("by_material", (index) => index.eq("materialId", created.materialId))
        .collect(),
    );
    expect(rows.map(({ version, kind }) => [version, kind])).toEqual([
      [1, "rich_text"],
      [2, "external_link"],
    ]);
  });

  it("registers file receipts through configured object storage with exportable metadata", async () => {
    const backend = createTestBackend();
    const { classroomId, courseId, teacher } = await seedContext(backend);
    const content = {
      kind: "file" as const,
      attachment: {
        storageKey: "organizations/north/materials/guide.pdf",
        filename: "Course Guide.pdf",
        contentType: "application/pdf",
        byteSize: 2048,
        sha256: "a".repeat(64),
      },
    };
    const { materialVersionId } = await teacher.mutation(api.materials.create, {
      courseId,
      title: "Course guide",
      content,
    });
    const version = await teacher.query(api.materials.getVersion, { materialVersionId });

    expect(version).toMatchObject({
      kind: "file",
      attachment: {
        storageProvider: "s3-compatible",
        storageBucket: "enkode-test",
        ...content.attachment,
      },
    });
    const materialReleaseId = await teacher.mutation(api.materialReleases.create, {
      classroomId,
      materialVersionId,
    });
    const student = backend.withIdentity({ subject: "auth-student" });
    expect(await student.query(api.materialReleases.open, { materialReleaseId })).toMatchObject({
      attachment: {
        storageProvider: "s3-compatible",
        storageBucket: "enkode-test",
        ...content.attachment,
      },
    });
    await expect(
      teacher.mutation(api.materials.create, { courseId, title: "Duplicate", content }),
    ).rejects.toThrow("already registered");

    vi.stubEnv("ENKODE_OBJECT_STORAGE_BUCKET", "");
    await expect(
      teacher.mutation(api.materials.create, {
        courseId,
        title: "Missing boundary",
        content: { ...content, attachment: { ...content.attachment, storageKey: "other.pdf" } },
      }),
    ).rejects.toThrow("Object storage is not configured");
  });

  it("pins a released Version until a Classroom Teacher explicitly adopts another", async () => {
    const backend = createTestBackend();
    const { classroomId, courseId, teacher } = await seedContext(backend);
    const created = await teacher.mutation(api.materials.create, {
      courseId,
      title: "Syllabus",
      content: richText,
    });
    const releaseId = await teacher.mutation(api.materialReleases.create, {
      classroomId,
      materialVersionId: created.materialVersionId,
    });
    const secondVersionId = await teacher.mutation(api.materials.createVersion, {
      materialId: created.materialId,
      content: { kind: "rich_text", richText: "Changed syllabus." },
    });

    expect(await teacher.query(api.materialReleases.listForClassroom, { classroomId })).toEqual([
      expect.objectContaining({ materialVersionId: created.materialVersionId, version: 1 }),
    ]);
    await teacher.mutation(api.materialReleases.adoptVersion, {
      materialReleaseId: releaseId,
      materialVersionId: secondVersionId,
    });
    expect(await teacher.query(api.materialReleases.listForClassroom, { classroomId })).toEqual([
      expect.objectContaining({ materialVersionId: secondVersionId, version: 2 }),
    ]);
    await expect(
      teacher.mutation(api.materialReleases.adoptVersion, {
        materialReleaseId: releaseId,
        materialVersionId: created.materialVersionId,
      }),
    ).rejects.toThrow("Adopt a newer Material Version");
    const events = await backend.run(async (ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_target", (index) =>
          index.eq("targetKind", "material_release").eq("targetId", releaseId),
        )
        .collect(),
    );
    expect(events.map(({ action }) => action)).toContain("material_release.version_adopted");
  });

  it("lets Classroom Teachers order Material Releases independently", async () => {
    const backend = createTestBackend();
    const { classroomId, courseId, teacher } = await seedContext(backend);
    const first = await teacher.mutation(api.materials.create, {
      courseId,
      title: "First in Course",
      content: richText,
    });
    const second = await teacher.mutation(api.materials.create, {
      courseId,
      title: "Second in Course",
      content: richText,
    });
    const secondReleaseId = await teacher.mutation(api.materialReleases.create, {
      classroomId,
      materialVersionId: second.materialVersionId,
    });
    const firstReleaseId = await teacher.mutation(api.materialReleases.create, {
      classroomId,
      materialVersionId: first.materialVersionId,
    });

    expect(
      (await teacher.query(api.materialReleases.listForClassroom, { classroomId })).map(
        ({ materialTitle }: { materialTitle: string }) => materialTitle,
      ),
    ).toEqual(["Second in Course", "First in Course"]);
    await teacher.mutation(api.materialReleases.move, {
      materialReleaseId: firstReleaseId,
      direction: "up",
    });
    expect(
      (await teacher.query(api.materialReleases.listForClassroom, { classroomId })).map(
        ({ _id }: { _id: Id<"materialReleases"> }) => _id,
      ),
    ).toEqual([firstReleaseId, secondReleaseId]);
  });

  it("honors immediate, draft, and scheduled publication timing", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 7, 26, 18);
    vi.setSystemTime(now);
    const backend = createTestBackend();
    const { classroomId, courseId, teacher } = await seedContext(backend);
    const student = backend.withIdentity({ subject: "auth-student" });
    const immediate = await teacher.mutation(api.materials.create, {
      courseId,
      title: "Immediate",
      content: richText,
    });
    const draft = await teacher.mutation(api.materials.create, {
      courseId,
      title: "Draft",
      content: richText,
    });
    const scheduled = await teacher.mutation(api.materials.create, {
      courseId,
      title: "Scheduled",
      content: richText,
    });
    const immediateReleaseId = await teacher.mutation(api.materialReleases.create, {
      classroomId,
      materialVersionId: immediate.materialVersionId,
    });
    const draftReleaseId = await teacher.mutation(api.materialReleases.create, {
      classroomId,
      materialVersionId: draft.materialVersionId,
      publication: "draft",
    });
    const scheduledFor = now + 60_000;
    const scheduledReleaseId = await teacher.mutation(api.materialReleases.create, {
      classroomId,
      materialVersionId: scheduled.materialVersionId,
      publication: { mode: "scheduled", scheduledFor },
    });

    expect(
      ((await student.query(api.materialReleases.listMine, {})) as MaterialReleaseSummary[]).map(
        ({ _id }) => _id,
      ),
    ).toEqual([immediateReleaseId]);
    vi.setSystemTime(scheduledFor);
    expect(
      ((await student.query(api.materialReleases.listMine, {})) as MaterialReleaseSummary[]).map(
        ({ _id }) => _id,
      ),
    ).toEqual([immediateReleaseId, scheduledReleaseId]);
    await backend.mutation(internal.materialReleases.publishScheduled, {
      materialReleaseId: scheduledReleaseId,
      scheduledFor,
    });
    await teacher.mutation(api.materialReleases.publishNow, { materialReleaseId: draftReleaseId });
    expect(
      ((await student.query(api.materialReleases.listMine, {})) as MaterialReleaseSummary[]).map(
        ({ _id }) => _id,
      ),
    ).toEqual([immediateReleaseId, draftReleaseId, scheduledReleaseId]);
  });

  it("enforces collaborator, Classroom Teacher, and active Enrollment authorization", async () => {
    const backend = createTestBackend();
    const { classroomId, courseId, enrollmentId, teacher } = await seedContext(backend);
    const created = await teacher.mutation(api.materials.create, {
      courseId,
      title: "Authorized",
      content: richText,
    });
    const releaseId = await teacher.mutation(api.materialReleases.create, {
      classroomId,
      materialVersionId: created.materialVersionId,
    });
    const unassigned = backend.withIdentity({ subject: "auth-unassigned" });
    const authorOnly = backend.withIdentity({ subject: "auth-author-only" });
    const classroomOnly = backend.withIdentity({ subject: "auth-classroom-only" });
    const otherOrganization = backend.withIdentity({ subject: "auth-other-org" });
    const student = backend.withIdentity({ subject: "auth-student" });
    const otherStudent = backend.withIdentity({ subject: "auth-other-student" });

    await expect(
      unassigned.mutation(api.materials.createVersion, {
        materialId: created.materialId,
        content: richText,
      }),
    ).rejects.toThrow("Forbidden");
    await expect(
      classroomOnly.mutation(api.materials.createVersion, {
        materialId: created.materialId,
        content: richText,
      }),
    ).rejects.toThrow("Forbidden");
    await expect(
      authorOnly.mutation(api.materialReleases.publishNow, { materialReleaseId: releaseId }),
    ).rejects.toThrow("Forbidden");
    await expect(
      unassigned.mutation(api.materialReleases.adoptVersion, {
        materialReleaseId: releaseId,
        materialVersionId: created.materialVersionId,
      }),
    ).rejects.toThrow("Forbidden");
    await expect(
      otherOrganization.query(api.materials.getVersion, {
        materialVersionId: created.materialVersionId,
      }),
    ).rejects.toThrow("Forbidden");
    expect(
      await student.query(api.materialReleases.open, { materialReleaseId: releaseId }),
    ).toMatchObject({ richText: richText.richText });
    await expect(
      otherStudent.query(api.materialReleases.open, { materialReleaseId: releaseId }),
    ).rejects.toThrow("Forbidden");
    await teacher.mutation(api.enrollments.end, { enrollmentId });
    expect(await student.query(api.materialReleases.listMine, {})).toEqual([]);
    await expect(
      student.query(api.materialReleases.open, { materialReleaseId: releaseId }),
    ).rejects.toThrow("Forbidden");
  });
});
