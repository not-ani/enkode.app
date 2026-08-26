import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { studentVisibleEvaluationTest } from "./assignmentPolicy";
import { appendAuditEvent } from "./audit";
import { requireClassroomTeacher, requireRole } from "./authorization";
import { adjacentOrder, validateReleasePoints } from "./releasePolicy";

async function requireActiveEnrollment(
  ctx: QueryCtx,
  classroomId: Id<"classrooms">,
  studentId: Id<"users">,
) {
  const enrollment = await ctx.db
    .query("enrollments")
    .withIndex("by_classroom_student", (index) =>
      index.eq("classroomId", classroomId).eq("studentId", studentId),
    )
    .unique();
  if (!enrollment || enrollment.status !== "active") throw new ConvexError("Forbidden");
  return enrollment;
}

async function releaseSummary(ctx: QueryCtx, release: Doc<"assignmentReleases">) {
  const [assignment, version] = await Promise.all([
    ctx.db.get(release.assignmentId),
    ctx.db.get(release.assignmentVersionId),
  ]);
  if (!assignment || !version) throw new ConvexError("Assignment Release content is unavailable");
  return {
    ...release,
    assignmentTitle: assignment.title,
    version: version.version,
    language: version.language,
    runtimeVersion: version.runtimeVersion,
  };
}

export const availableVersions = query({
  args: { classroomId: v.id("classrooms") },
  handler: async (ctx, { classroomId }) => {
    const { classroom } = await requireClassroomTeacher(ctx, classroomId);
    const assignments = await ctx.db
      .query("assignments")
      .withIndex("by_course", (index) => index.eq("courseId", classroom.courseId))
      .collect();
    const options = await Promise.all(
      assignments.map(async (assignment) => {
        const versions = await ctx.db
          .query("assignmentVersions")
          .withIndex("by_assignment", (index) => index.eq("assignmentId", assignment._id))
          .collect();
        return versions.map((version) => ({
          assignmentId: assignment._id,
          assignmentTitle: assignment.title,
          assignmentVersionId: version._id,
          version: version.version,
          language: version.language,
          runtimeVersion: version.runtimeVersion,
        }));
      }),
    );
    return options
      .flat()
      .sort((left, right) =>
        left.assignmentTitle === right.assignmentTitle
          ? right.version - left.version
          : left.assignmentTitle.localeCompare(right.assignmentTitle),
      );
  },
});

export const create = mutation({
  args: {
    classroomId: v.id("classrooms"),
    assignmentVersionId: v.id("assignmentVersions"),
    points: v.number(),
  },
  handler: async (ctx, { classroomId, assignmentVersionId, points }) => {
    const { classroom, organization, user } = await requireClassroomTeacher(ctx, classroomId);
    const version = await ctx.db.get(assignmentVersionId);
    if (!version || version.organizationId !== organization._id) {
      throw new ConvexError("Assignment Version not found");
    }
    const assignment = await ctx.db.get(version.assignmentId);
    if (!assignment || assignment.courseId !== classroom.courseId) {
      throw new ConvexError("Assignment Version does not belong to this Classroom's Course");
    }
    const existing = await ctx.db
      .query("assignmentReleases")
      .withIndex("by_classroom_assignment", (index) =>
        index.eq("classroomId", classroomId).eq("assignmentId", assignment._id),
      )
      .unique();
    if (existing) throw new ConvexError("Assignment is already released to this Classroom");

    const releases = await ctx.db
      .query("assignmentReleases")
      .withIndex("by_classroom", (index) => index.eq("classroomId", classroomId))
      .collect();
    const now = Date.now();
    const releaseId = await ctx.db.insert("assignmentReleases", {
      organizationId: organization._id,
      classroomId,
      assignmentId: assignment._id,
      assignmentVersionId,
      points: validateReleasePoints(points),
      order: releases.length,
      publishedAt: now,
      createdBy: user._id,
      createdAt: now,
    });
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "assignment_release.created",
      target: { kind: "assignment_release", id: releaseId },
    });
    return releaseId;
  },
});

export const listForClassroom = query({
  args: { classroomId: v.id("classrooms") },
  handler: async (ctx, { classroomId }) => {
    await requireClassroomTeacher(ctx, classroomId);
    const releases = await ctx.db
      .query("assignmentReleases")
      .withIndex("by_classroom", (index) => index.eq("classroomId", classroomId))
      .collect();
    return await Promise.all(releases.map((release) => releaseSummary(ctx, release)));
  },
});

export const move = mutation({
  args: {
    assignmentReleaseId: v.id("assignmentReleases"),
    direction: v.union(v.literal("up"), v.literal("down")),
  },
  handler: async (ctx, { assignmentReleaseId, direction }) => {
    const release = await ctx.db.get(assignmentReleaseId);
    if (!release) throw new ConvexError("Assignment Release not found");
    const { organization, user } = await requireClassroomTeacher(ctx, release.classroomId);
    const releases = await ctx.db
      .query("assignmentReleases")
      .withIndex("by_classroom", (index) => index.eq("classroomId", release.classroomId))
      .collect();
    const targetOrder = adjacentOrder(releases, release.order, direction);
    if (targetOrder === undefined) return;
    const adjacent = releases.find(({ order }) => order === targetOrder);
    if (!adjacent) throw new ConvexError("Assignment Release order is unavailable");
    await ctx.db.patch(adjacent._id, { order: release.order });
    await ctx.db.patch(release._id, { order: targetOrder });
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "assignment_release.reordered",
      target: { kind: "assignment_release", id: release._id },
    });
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireRole(ctx, "student");
    const enrollments = await ctx.db
      .query("enrollments")
      .withIndex("by_student_status", (index) =>
        index.eq("studentId", user._id).eq("status", "active"),
      )
      .collect();
    const groups = await Promise.all(
      enrollments.map(async (enrollment) => {
        const classroom = await ctx.db.get(enrollment.classroomId);
        if (!classroom || classroom.organizationId !== user.organizationId) return [];
        const releases = await ctx.db
          .query("assignmentReleases")
          .withIndex("by_classroom", (index) => index.eq("classroomId", classroom._id))
          .collect();
        const published = releases.filter(({ publishedAt }) => publishedAt <= Date.now());
        return await Promise.all(
          published.map(async (release) => ({
            ...(await releaseSummary(ctx, release)),
            classroomName: classroom.name,
          })),
        );
      }),
    );
    return groups.flat();
  },
});

export const open = query({
  args: { assignmentReleaseId: v.id("assignmentReleases") },
  handler: async (ctx, { assignmentReleaseId }) => {
    const { user } = await requireRole(ctx, "student");
    const release = await ctx.db.get(assignmentReleaseId);
    if (
      !release ||
      release.organizationId !== user.organizationId ||
      release.publishedAt > Date.now()
    ) {
      throw new ConvexError("Forbidden");
    }
    await requireActiveEnrollment(ctx, release.classroomId, user._id);
    const [summary, starterFiles, evaluationTests] = await Promise.all([
      releaseSummary(ctx, release),
      ctx.db
        .query("assignmentStarterFiles")
        .withIndex("by_version", (index) =>
          index.eq("assignmentVersionId", release.assignmentVersionId),
        )
        .collect(),
      ctx.db
        .query("evaluationTests")
        .withIndex("by_version", (index) =>
          index.eq("assignmentVersionId", release.assignmentVersionId),
        )
        .collect(),
    ]);
    const version = await ctx.db.get(release.assignmentVersionId);
    if (!version) throw new ConvexError("Assignment Release content is unavailable");
    return {
      ...summary,
      instructions: version.instructions,
      entrypoint: version.entrypoint,
      starterFiles,
      evaluationTests: evaluationTests.map(studentVisibleEvaluationTest),
    };
  },
});
