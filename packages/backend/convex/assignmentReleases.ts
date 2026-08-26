import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { studentVisibleEvaluationTest } from "./assignmentPolicy";
import { mergePlan } from "./assignmentVersionMerge";
import { appendAuditEvent } from "./audit";
import { requireClassroomTeacher, requireRole } from "./authorization";
import {
  adjacentOrder,
  releasePublicationStatus,
  validateReleasePoints,
  validateScheduledFor,
} from "./releasePolicy";

const publication = v.union(
  v.literal("immediate"),
  v.literal("draft"),
  v.object({ mode: v.literal("scheduled"), scheduledFor: v.number() }),
);

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
    latestVersion: assignment.latestVersion,
    language: version.language,
    runtimeVersion: version.runtimeVersion,
    publicationStatus: releasePublicationStatus(release),
  };
}

async function requireAdoptionTarget(
  ctx: QueryCtx,
  release: Doc<"assignmentReleases">,
  assignmentVersionId: Id<"assignmentVersions">,
) {
  const [current, target] = await Promise.all([
    ctx.db.get(release.assignmentVersionId),
    ctx.db.get(assignmentVersionId),
  ]);
  if (
    !current ||
    !target ||
    target.organizationId !== release.organizationId ||
    target.assignmentId !== release.assignmentId
  ) {
    throw new ConvexError("Assignment Version is not available for this release");
  }
  if (target.version <= current.version) {
    throw new ConvexError("Choose an Assignment Version newer than the release's current version");
  }
  return { current, target };
}

async function requireEditableRelease(
  ctx: Parameters<typeof requireClassroomTeacher>[0],
  assignmentReleaseId: Id<"assignmentReleases">,
) {
  const release = await ctx.db.get(assignmentReleaseId);
  if (!release) throw new ConvexError("Assignment Release not found");
  const authenticated = await requireClassroomTeacher(ctx, release.classroomId);
  return { ...authenticated, release };
}

async function auditRelease(
  ctx: Parameters<typeof appendAuditEvent>[0],
  release: Doc<"assignmentReleases">,
  userId: Id<"users">,
  action: string,
) {
  await appendAuditEvent(ctx, {
    organizationId: release.organizationId,
    actor: { kind: "user", userId },
    action,
    target: { kind: "assignment_release", id: release._id },
  });
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
    publication: v.optional(publication),
  },
  handler: async (ctx, { classroomId, assignmentVersionId, points, publication = "immediate" }) => {
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
    const scheduledFor =
      typeof publication === "object"
        ? validateScheduledFor(publication.scheduledFor, now)
        : undefined;
    const publicationState =
      publication === "immediate"
        ? ("published" as const)
        : publication === "draft"
          ? ("draft" as const)
          : ("scheduled" as const);
    const releaseId = await ctx.db.insert("assignmentReleases", {
      organizationId: organization._id,
      classroomId,
      assignmentId: assignment._id,
      assignmentVersionId,
      points: validateReleasePoints(points),
      order: releases.length,
      publicationState,
      scheduledFor,
      scheduledBy: scheduledFor === undefined ? undefined : user._id,
      publishedAt: publicationState === "published" ? now : undefined,
      createdBy: user._id,
      createdAt: now,
    });
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "assignment_release.created",
      target: { kind: "assignment_release", id: releaseId },
    });
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action:
        publicationState === "published"
          ? "assignment_release.published"
          : publicationState === "draft"
            ? "assignment_release.draft_saved"
            : "assignment_release.scheduled",
      target: { kind: "assignment_release", id: releaseId },
    });
    if (scheduledFor !== undefined) {
      await ctx.scheduler.runAt(scheduledFor, internal.assignmentReleases.publishScheduled, {
        assignmentReleaseId: releaseId,
        scheduledFor,
      });
    }
    return releaseId;
  },
});

export const schedule = mutation({
  args: {
    assignmentReleaseId: v.id("assignmentReleases"),
    scheduledFor: v.number(),
  },
  handler: async (ctx, { assignmentReleaseId, scheduledFor: requestedTime }) => {
    const { release, user } = await requireEditableRelease(ctx, assignmentReleaseId);
    const now = Date.now();
    if (releasePublicationStatus(release, now) === "published") {
      throw new ConvexError("A published Assignment Release cannot be scheduled again");
    }
    const scheduledFor = validateScheduledFor(requestedTime, now);
    if (release.publicationState === "scheduled" && release.scheduledFor === scheduledFor) return;

    const action =
      release.publicationState === "scheduled"
        ? "assignment_release.schedule_changed"
        : "assignment_release.scheduled";
    await ctx.db.patch(release._id, {
      publicationState: "scheduled",
      scheduledFor,
      scheduledBy: user._id,
      publishedAt: undefined,
    });
    await auditRelease(ctx, release, user._id, action);
    await ctx.scheduler.runAt(scheduledFor, internal.assignmentReleases.publishScheduled, {
      assignmentReleaseId,
      scheduledFor,
    });
  },
});

export const cancelSchedule = mutation({
  args: { assignmentReleaseId: v.id("assignmentReleases") },
  handler: async (ctx, { assignmentReleaseId }) => {
    const { release, user } = await requireEditableRelease(ctx, assignmentReleaseId);
    if (releasePublicationStatus(release) === "published") {
      throw new ConvexError("A published Assignment Release cannot return to draft");
    }
    if (release.publicationState !== "scheduled") return;
    await ctx.db.patch(release._id, {
      publicationState: "draft",
      scheduledFor: undefined,
      scheduledBy: undefined,
      publishedAt: undefined,
    });
    await auditRelease(ctx, release, user._id, "assignment_release.schedule_canceled");
  },
});

export const publishNow = mutation({
  args: { assignmentReleaseId: v.id("assignmentReleases") },
  handler: async (ctx, { assignmentReleaseId }) => {
    const { release, user } = await requireEditableRelease(ctx, assignmentReleaseId);
    if (releasePublicationStatus(release) === "published") return;
    await ctx.db.patch(release._id, {
      publicationState: "published",
      scheduledFor: undefined,
      scheduledBy: undefined,
      publishedAt: Date.now(),
    });
    await auditRelease(ctx, release, user._id, "assignment_release.published");
  },
});

export const publishScheduled = internalMutation({
  args: {
    assignmentReleaseId: v.id("assignmentReleases"),
    scheduledFor: v.number(),
  },
  handler: async (ctx, { assignmentReleaseId, scheduledFor }) => {
    const release = await ctx.db.get(assignmentReleaseId);
    if (
      !release ||
      release.publicationState !== "scheduled" ||
      release.scheduledFor !== scheduledFor ||
      scheduledFor > Date.now()
    ) {
      return;
    }
    await ctx.db.patch(release._id, {
      publicationState: "published",
      scheduledFor: undefined,
      scheduledBy: undefined,
      publishedAt: scheduledFor,
    });
    await auditRelease(
      ctx,
      release,
      release.scheduledBy ?? release.createdBy,
      "assignment_release.published",
    );
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

export const previewAdoption = query({
  args: {
    assignmentReleaseId: v.id("assignmentReleases"),
    assignmentVersionId: v.id("assignmentVersions"),
  },
  handler: async (ctx, { assignmentReleaseId, assignmentVersionId }) => {
    const release = await ctx.db.get(assignmentReleaseId);
    if (!release) throw new ConvexError("Assignment Release not found");
    await requireClassroomTeacher(ctx, release.classroomId);
    const { current, target } = await requireAdoptionTarget(ctx, release, assignmentVersionId);
    return await mergePlan(ctx, current, target);
  },
});

export const adoptVersion = mutation({
  args: {
    assignmentReleaseId: v.id("assignmentReleases"),
    assignmentVersionId: v.id("assignmentVersions"),
  },
  handler: async (ctx, { assignmentReleaseId, assignmentVersionId }) => {
    const { release, user } = await requireEditableRelease(ctx, assignmentReleaseId);
    const { current, target } = await requireAdoptionTarget(ctx, release, assignmentVersionId);
    const workspaces = await ctx.db
      .query("workspaces")
      .withIndex("by_assignment_release", (index) =>
        index.eq("assignmentReleaseId", assignmentReleaseId),
      )
      .collect();
    const now = Date.now();
    const adoptionId = await ctx.db.insert("assignmentReleaseAdoptions", {
      organizationId: release.organizationId,
      assignmentReleaseId,
      fromAssignmentVersionId: current._id,
      toAssignmentVersionId: target._id,
      adoptedBy: user._id,
      adoptedAt: now,
    });
    let workspacesAwaitingMerge = 0;

    for (const workspace of workspaces) {
      const pending = await ctx.db
        .query("workspaceVersionMerges")
        .withIndex("by_workspace_status", (index) =>
          index.eq("workspaceId", workspace._id).eq("status", "pending"),
        )
        .collect();
      for (const merge of pending) await ctx.db.patch(merge._id, { status: "superseded" });

      const workspaceVersion = await ctx.db.get(workspace.assignmentVersionId);
      if (!workspaceVersion) throw new ConvexError("Workspace Assignment Version is unavailable");
      const workspacePlan = await mergePlan(ctx, workspaceVersion, target);
      const status = workspacePlan.changedStarterFiles.length === 0 ? "completed" : "pending";
      if (status === "pending") workspacesAwaitingMerge += 1;
      await ctx.db.insert("workspaceVersionMerges", {
        organizationId: release.organizationId,
        workspaceId: workspace._id,
        assignmentReleaseId,
        adoptionId,
        fromAssignmentVersionId: workspaceVersion._id,
        toAssignmentVersionId: target._id,
        status,
        createdAt: now,
        completedAt: status === "completed" ? now : undefined,
        decisions: status === "completed" ? [] : undefined,
      });
      if (status === "completed") {
        await ctx.db.patch(workspace._id, { assignmentVersionId: target._id, updatedAt: now });
      }
    }

    await ctx.db.patch(release._id, { assignmentVersionId: target._id });
    await auditRelease(ctx, release, user._id, "assignment_release.version_adopted");
    return { adoptionId, workspacesAwaitingMerge };
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
        const published = releases.filter(
          (release) => releasePublicationStatus(release) === "published",
        );
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
      releasePublicationStatus(release) !== "published"
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
