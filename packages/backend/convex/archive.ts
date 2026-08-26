import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { permanentDeletionBlocker, permanentDeletionMessage } from "./archivePolicy";
import { appendAuditEvent } from "./audit";
import { requireClassroomTeacher, requireCourseCollaborator, requireRole } from "./authorization";

type ArchiveTarget = "assignment" | "material" | "course" | "classroom";

async function audit(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  userId: Id<"users">,
  kind: ArchiveTarget,
  id: string,
  action: "archived" | "deleted",
) {
  await appendAuditEvent(ctx, {
    organizationId,
    actor: { kind: "user", userId },
    action: `${kind}.${action}`,
    target: { kind, id },
  });
}

async function assertDeleteAllowed(input: {
  wasReleased: boolean;
  hasSubmission: boolean;
  hasGrade: boolean;
  hasReference: boolean;
}) {
  const blocker = permanentDeletionBlocker(input);
  if (blocker) throw new ConvexError(permanentDeletionMessage(blocker));
}

export const archiveAssignment = mutation({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, { assignmentId }) => {
    const assignment = await ctx.db.get(assignmentId);
    if (!assignment) throw new ConvexError("Assignment not found");
    const { organization, user } = await requireCourseCollaborator(ctx, assignment.courseId);
    if (assignment.archivedAt !== undefined) return;
    await ctx.db.patch(assignmentId, { archivedAt: Date.now(), archivedBy: user._id });
    await audit(ctx, organization._id, user._id, "assignment", assignmentId, "archived");
  },
});

export const archiveMaterial = mutation({
  args: { materialId: v.id("materials") },
  handler: async (ctx, { materialId }) => {
    const material = await ctx.db.get(materialId);
    if (!material) throw new ConvexError("Material not found");
    const { organization, user } = await requireCourseCollaborator(ctx, material.courseId);
    if (material.archivedAt !== undefined) return;
    await ctx.db.patch(materialId, { archivedAt: Date.now(), archivedBy: user._id });
    await audit(ctx, organization._id, user._id, "material", materialId, "archived");
  },
});

export const archiveCourse = mutation({
  args: { courseId: v.id("courses") },
  handler: async (ctx, { courseId }) => {
    const { course, organization, user } = await requireCourseCollaborator(ctx, courseId);
    if (course.archivedAt !== undefined) return;
    await ctx.db.patch(courseId, { archivedAt: Date.now(), archivedBy: user._id });
    await audit(ctx, organization._id, user._id, "course", courseId, "archived");
  },
});

export const archiveClassroom = mutation({
  args: { classroomId: v.id("classrooms") },
  handler: async (ctx, { classroomId }) => {
    const { classroom, organization, user } = await requireClassroomTeacher(ctx, classroomId);
    if (classroom.archivedAt !== undefined) return;
    await ctx.db.patch(classroomId, { archivedAt: Date.now(), archivedBy: user._id });
    await audit(ctx, organization._id, user._id, "classroom", classroomId, "archived");
  },
});

export const deleteAssignmentDraft = mutation({
  args: { assignmentId: v.id("assignments") },
  handler: async (ctx, { assignmentId }) => {
    const assignment = await ctx.db.get(assignmentId);
    if (!assignment) throw new ConvexError("Assignment not found");
    const { organization, user } = await requireCourseCollaborator(ctx, assignment.courseId);
    const versions = await ctx.db
      .query("assignmentVersions")
      .withIndex("by_assignment", (index) => index.eq("assignmentId", assignmentId))
      .collect();
    const versionIds = new Set(versions.map(({ _id }) => _id));
    const releases = (await ctx.db.query("assignmentReleases").collect()).filter(
      (release) => release.assignmentId === assignmentId,
    );
    const submissions = (await ctx.db.query("submissions").collect()).filter((submission) =>
      versionIds.has(submission.assignmentVersionId),
    );
    const releaseIds = new Set(releases.map(({ _id }) => _id));
    const grades = (await ctx.db.query("grades").collect()).filter((grade) =>
      releaseIds.has(grade.assignmentReleaseId),
    );
    await assertDeleteAllowed({
      wasReleased: releases.some(
        (release) => release.publishedAt !== undefined || release.publicationState === "published",
      ),
      hasSubmission: submissions.length > 0,
      hasGrade: grades.length > 0,
      hasReference: releases.length > 0,
    });

    for (const version of versions) {
      const [files, tests] = await Promise.all([
        ctx.db
          .query("assignmentStarterFiles")
          .withIndex("by_version", (index) => index.eq("assignmentVersionId", version._id))
          .collect(),
        ctx.db
          .query("evaluationTests")
          .withIndex("by_version", (index) => index.eq("assignmentVersionId", version._id))
          .collect(),
      ]);
      for (const file of files) await ctx.db.delete(file._id);
      for (const test of tests) await ctx.db.delete(test._id);
      await ctx.db.delete(version._id);
    }
    await audit(ctx, organization._id, user._id, "assignment", assignmentId, "deleted");
    await ctx.db.delete(assignmentId);
  },
});

export const deleteMaterialDraft = mutation({
  args: { materialId: v.id("materials") },
  handler: async (ctx, { materialId }) => {
    const material = await ctx.db.get(materialId);
    if (!material) throw new ConvexError("Material not found");
    const { organization, user } = await requireCourseCollaborator(ctx, material.courseId);
    const versions = await ctx.db
      .query("materialVersions")
      .withIndex("by_material", (index) => index.eq("materialId", materialId))
      .collect();
    const releases = (await ctx.db.query("materialReleases").collect()).filter(
      (release) => release.materialId === materialId,
    );
    await assertDeleteAllowed({
      wasReleased: releases.some(
        (release) => release.publishedAt !== undefined || release.publicationState === "published",
      ),
      hasSubmission: false,
      hasGrade: false,
      hasReference: releases.length > 0,
    });
    for (const version of versions) {
      if (version.attachmentId) await ctx.db.delete(version.attachmentId);
      await ctx.db.delete(version._id);
    }
    await audit(ctx, organization._id, user._id, "material", materialId, "deleted");
    await ctx.db.delete(materialId);
  },
});

export const deleteCourseDraft = mutation({
  args: { courseId: v.id("courses") },
  handler: async (ctx, { courseId }) => {
    const { organization, user } = await requireCourseCollaborator(ctx, courseId);
    const [assignments, materials, classrooms] = await Promise.all([
      ctx.db
        .query("assignments")
        .withIndex("by_course", (i) => i.eq("courseId", courseId))
        .collect(),
      ctx.db
        .query("materials")
        .withIndex("by_course", (i) => i.eq("courseId", courseId))
        .collect(),
      ctx.db
        .query("classrooms")
        .withIndex("by_course", (i) => i.eq("courseId", courseId))
        .collect(),
    ]);
    await assertDeleteAllowed({
      wasReleased: false,
      hasSubmission: false,
      hasGrade: false,
      hasReference: assignments.length + materials.length + classrooms.length > 0,
    });
    const collaborators = await ctx.db
      .query("courseCollaborators")
      .withIndex("by_course", (i) => i.eq("courseId", courseId))
      .collect();
    for (const collaborator of collaborators) await ctx.db.delete(collaborator._id);
    await audit(ctx, organization._id, user._id, "course", courseId, "deleted");
    await ctx.db.delete(courseId);
  },
});

export const deleteClassroomDraft = mutation({
  args: { classroomId: v.id("classrooms") },
  handler: async (ctx, { classroomId }) => {
    const { organization, user } = await requireClassroomTeacher(ctx, classroomId);
    const [assignmentReleases, materialReleases, enrollments] = await Promise.all([
      ctx.db
        .query("assignmentReleases")
        .withIndex("by_classroom", (i) => i.eq("classroomId", classroomId))
        .collect(),
      ctx.db
        .query("materialReleases")
        .withIndex("by_classroom", (i) => i.eq("classroomId", classroomId))
        .collect(),
      ctx.db
        .query("enrollments")
        .withIndex("by_classroom", (i) => i.eq("classroomId", classroomId))
        .collect(),
    ]);
    await assertDeleteAllowed({
      wasReleased: [...assignmentReleases, ...materialReleases].some(
        (release) => release.publishedAt !== undefined || release.publicationState === "published",
      ),
      hasSubmission: false,
      hasGrade: false,
      hasReference: assignmentReleases.length + materialReleases.length + enrollments.length > 0,
    });
    const teachers = await ctx.db
      .query("classroomTeachers")
      .withIndex("by_classroom", (i) => i.eq("classroomId", classroomId))
      .collect();
    for (const teacher of teachers) await ctx.db.delete(teacher._id);
    await audit(ctx, organization._id, user._id, "classroom", classroomId, "deleted");
    await ctx.db.delete(classroomId);
  },
});

export const listArchived = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireRole(ctx, "teacher");
    const [courseLinks, classroomLinks] = await Promise.all([
      ctx.db
        .query("courseCollaborators")
        .withIndex("by_teacher", (i) => i.eq("teacherId", user._id))
        .collect(),
      ctx.db
        .query("classroomTeachers")
        .withIndex("by_teacher", (i) => i.eq("teacherId", user._id))
        .collect(),
    ]);
    const courses = (
      await Promise.all(courseLinks.map(({ courseId }) => ctx.db.get(courseId)))
    ).filter((course) => course?.archivedAt !== undefined);
    const classrooms = (
      await Promise.all(classroomLinks.map(({ classroomId }) => ctx.db.get(classroomId)))
    ).filter((classroom) => classroom?.archivedAt !== undefined);
    const courseIds = courseLinks.map(({ courseId }) => courseId);
    const [assignmentGroups, materialGroups] = await Promise.all([
      Promise.all(
        courseIds.map((courseId) =>
          ctx.db
            .query("assignments")
            .withIndex("by_course", (index) => index.eq("courseId", courseId))
            .collect(),
        ),
      ),
      Promise.all(
        courseIds.map((courseId) =>
          ctx.db
            .query("materials")
            .withIndex("by_course", (index) => index.eq("courseId", courseId))
            .collect(),
        ),
      ),
    ]);
    const assignments = assignmentGroups
      .flat()
      .filter(({ archivedAt }) => archivedAt !== undefined);
    const materials = materialGroups.flat().filter(({ archivedAt }) => archivedAt !== undefined);
    return { assignments, courses, classrooms, materials };
  },
});
