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
  deriveDeadlineFacts,
  effectiveDeadline,
  submissionEligibility,
  validateDeadlineConfiguration,
  validateSubmissionLimit,
} from "./deadlinePolicy";
import {
  isArchived,
  requireWritableAssignment,
  requireWritableAssignmentRelease,
  requireWritableClassroom,
} from "./lifecycleGuards";
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
const deadlinePolicy = v.union(
  v.literal("no_deadline"),
  v.literal("accept_late"),
  v.literal("hard_close"),
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
    deadlinePolicy: release.deadlinePolicy ?? "no_deadline",
  };
}

async function studentDeadlineSummary(
  ctx: QueryCtx,
  release: Doc<"assignmentReleases">,
  studentId: Id<"users">,
  now = Date.now(),
) {
  const [exception, submissions] = await Promise.all([
    ctx.db
      .query("deadlineExceptions")
      .withIndex("by_release_student", (index) =>
        index.eq("assignmentReleaseId", release._id).eq("studentId", studentId),
      )
      .unique(),
    ctx.db
      .query("submissions")
      .withIndex("by_release_student_attempt", (index) =>
        index.eq("assignmentReleaseId", release._id).eq("studentId", studentId),
      )
      .collect(),
  ]);
  const deadline = effectiveDeadline(release, exception);
  return {
    effectiveDeadline: deadline,
    submissionEligibility: submissionEligibility({
      ...deadline,
      submissionLimit: release.submissionLimit,
      attemptsUsed: submissions.length,
      now,
    }),
    deadlineFacts: deriveDeadlineFacts({
      deadlineAt: deadline.deadlineAt,
      attemptsUsed: submissions.length,
      hasLateSubmission: submissions.some(({ late }) => late === true),
      now,
    }),
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
  const release = await requireWritableAssignmentRelease(ctx, assignmentReleaseId);
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
      assignments
        .filter(({ archivedAt }) => archivedAt === undefined)
        .map(async (assignment) => {
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
    deadlinePolicy: v.optional(deadlinePolicy),
    deadlineAt: v.optional(v.number()),
    submissionLimit: v.optional(v.number()),
  },
  handler: async (ctx, input) => {
    const {
      classroomId,
      assignmentVersionId,
      points,
      publication = "immediate",
      submissionLimit: requestedLimit,
    } = input;
    const { classroom, organization, user } = await requireClassroomTeacher(ctx, classroomId);
    await requireWritableClassroom(ctx, classroomId);
    const version = await ctx.db.get(assignmentVersionId);
    if (!version || version.organizationId !== organization._id) {
      throw new ConvexError("Assignment Version not found");
    }
    const assignment = await ctx.db.get(version.assignmentId);
    if (!assignment || assignment.courseId !== classroom.courseId) {
      throw new ConvexError("Assignment Version does not belong to this Classroom's Course");
    }
    await requireWritableAssignment(ctx, assignment._id);
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
    const deadline = validateDeadlineConfiguration(input);
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
      ...deadline,
      submissionLimit: validateSubmissionLimit(requestedLimit),
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

export const configureSubmissionPolicy = mutation({
  args: {
    assignmentReleaseId: v.id("assignmentReleases"),
    deadlinePolicy,
    deadlineAt: v.optional(v.number()),
    submissionLimit: v.optional(v.number()),
  },
  handler: async (ctx, input) => {
    const { release, user } = await requireEditableRelease(ctx, input.assignmentReleaseId);
    const deadline = validateDeadlineConfiguration(input);
    const submissionLimit = validateSubmissionLimit(input.submissionLimit);
    if (
      (release.deadlinePolicy ?? "no_deadline") === deadline.deadlinePolicy &&
      release.deadlineAt === deadline.deadlineAt &&
      release.submissionLimit === submissionLimit
    ) {
      return;
    }
    await ctx.db.patch(release._id, { ...deadline, submissionLimit });
    await auditRelease(ctx, release, user._id, "assignment_release.submission_policy_changed");
  },
});

export const setDeadlineException = mutation({
  args: {
    assignmentReleaseId: v.id("assignmentReleases"),
    studentId: v.id("users"),
    deadlinePolicy,
    deadlineAt: v.optional(v.number()),
  },
  handler: async (ctx, input) => {
    const { release, organization, user } = await requireEditableRelease(
      ctx,
      input.assignmentReleaseId,
    );
    const student = await ctx.db.get(input.studentId);
    if (!student || student.organizationId !== organization._id || student.role !== "student") {
      throw new ConvexError("Student not found in this organization");
    }
    const enrollment = await ctx.db
      .query("enrollments")
      .withIndex("by_classroom_student", (index) =>
        index.eq("classroomId", release.classroomId).eq("studentId", student._id),
      )
      .unique();
    if (!enrollment) throw new ConvexError("Student is not enrolled in this Classroom");
    const deadline = validateDeadlineConfiguration(input);
    const existing = await ctx.db
      .query("deadlineExceptions")
      .withIndex("by_release_student", (index) =>
        index.eq("assignmentReleaseId", release._id).eq("studentId", student._id),
      )
      .unique();
    const now = Date.now();
    if (
      existing &&
      existing.deadlinePolicy === deadline.deadlinePolicy &&
      existing.deadlineAt === deadline.deadlineAt
    ) {
      return existing._id;
    }
    let exceptionId: Id<"deadlineExceptions">;
    if (existing) {
      await ctx.db.patch(existing._id, { ...deadline, updatedBy: user._id, updatedAt: now });
      exceptionId = existing._id;
    } else {
      exceptionId = await ctx.db.insert("deadlineExceptions", {
        organizationId: organization._id,
        assignmentReleaseId: release._id,
        studentId: student._id,
        ...deadline,
        updatedBy: user._id,
        createdAt: now,
        updatedAt: now,
      });
    }
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: existing ? "deadline_exception.changed" : "deadline_exception.created",
      target: { kind: "deadline_exception", id: exceptionId },
    });
    return exceptionId;
  },
});

export const removeDeadlineException = mutation({
  args: { assignmentReleaseId: v.id("assignmentReleases"), studentId: v.id("users") },
  handler: async (ctx, { assignmentReleaseId, studentId }) => {
    const { organization, user } = await requireEditableRelease(ctx, assignmentReleaseId);
    const existing = await ctx.db
      .query("deadlineExceptions")
      .withIndex("by_release_student", (index) =>
        index.eq("assignmentReleaseId", assignmentReleaseId).eq("studentId", studentId),
      )
      .unique();
    if (!existing) return;
    await ctx.db.delete(existing._id);
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "deadline_exception.removed",
      target: { kind: "deadline_exception", id: existing._id },
    });
  },
});

export const listDeadlineExceptions = query({
  args: { assignmentReleaseId: v.id("assignmentReleases") },
  handler: async (ctx, { assignmentReleaseId }) => {
    const release = await ctx.db.get(assignmentReleaseId);
    if (!release) throw new ConvexError("Assignment Release not found");
    await requireClassroomTeacher(ctx, release.classroomId);
    const exceptions = await ctx.db
      .query("deadlineExceptions")
      .withIndex("by_release", (index) => index.eq("assignmentReleaseId", assignmentReleaseId))
      .collect();
    return await Promise.all(
      exceptions.map(async (exception) => ({
        ...exception,
        studentName: (await ctx.db.get(exception.studentId))?.displayName ?? "Student",
      })),
    );
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
    const [classroom, assignment] = await Promise.all([
      ctx.db.get(release.classroomId),
      ctx.db.get(release.assignmentId),
    ]);
    if (!classroom || !assignment || isArchived(classroom) || isArchived(assignment)) return;
    const course = await ctx.db.get(classroom.courseId);
    if (!course || isArchived(course)) return;
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
    const active = [];
    for (const release of releases) {
      const assignment = await ctx.db.get(release.assignmentId);
      if (assignment?.archivedAt === undefined) active.push(release);
    }
    return await Promise.all(active.map((release) => releaseSummary(ctx, release)));
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
    const release = await requireWritableAssignmentRelease(ctx, assignmentReleaseId);
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
        if (
          !classroom ||
          classroom.organizationId !== user.organizationId ||
          classroom.archivedAt !== undefined
        )
          return [];
        const course = await ctx.db.get(classroom.courseId);
        if (!course || course.archivedAt !== undefined) return [];
        const releases = await ctx.db
          .query("assignmentReleases")
          .withIndex("by_classroom", (index) => index.eq("classroomId", classroom._id))
          .collect();
        const published = [];
        for (const release of releases) {
          const assignment = await ctx.db.get(release.assignmentId);
          if (
            releasePublicationStatus(release) === "published" &&
            assignment?.archivedAt === undefined
          )
            published.push(release);
        }
        return await Promise.all(
          published.map(async (release) => ({
            ...(await releaseSummary(ctx, release)),
            classroomName: classroom.name,
            ...(await studentDeadlineSummary(ctx, release, user._id)),
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
      ...(await studentDeadlineSummary(ctx, release, user._id)),
      instructions: version.instructions,
      entrypoint: version.entrypoint,
      starterFiles,
      evaluationTests: evaluationTests.map(studentVisibleEvaluationTest),
    };
  },
});
