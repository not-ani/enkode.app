import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internalQuery, query } from "./_generated/server";
import { requireRole } from "./authorization";

const targetKinds = [
  "organization",
  "user",
  "course",
  "course_collaborator",
  "classroom",
  "classroom_teacher",
  "enrollment",
  "assignment",
  "assignment_version",
  "assignment_release",
  "deadline_exception",
  "assignment_excuse",
  "grade_return",
  "workspace",
  "material",
  "material_version",
  "material_release",
] as const;

type TargetKind = (typeof targetKinds)[number];

type AuditEvent = {
  organizationId: Id<"organizations">;
  actor: { kind: "developer" } | { kind: "user"; userId: Id<"users"> };
  action: string;
  target: { kind: TargetKind; id: string };
};

type AuditScope = {
  courseId?: Id<"courses">;
  classroomId?: Id<"classrooms">;
};

async function classroomScope(ctx: MutationCtx, classroomId: Id<"classrooms">) {
  const classroom = await ctx.db.get(classroomId);
  return classroom ? { courseId: classroom.courseId, classroomId } : {};
}

async function releaseScope(
  ctx: MutationCtx,
  release: Pick<Doc<"assignmentReleases"> | Doc<"materialReleases">, "classroomId"> | null,
) {
  return release ? await classroomScope(ctx, release.classroomId) : {};
}

async function scopeForTarget(ctx: MutationCtx, target: AuditEvent["target"]): Promise<AuditScope> {
  switch (target.kind) {
    case "organization":
    case "user":
      return {};
    case "course":
      return { courseId: target.id as Id<"courses"> };
    case "course_collaborator": {
      const assignment = await ctx.db.get(target.id as Id<"courseCollaborators">);
      return assignment ? { courseId: assignment.courseId } : {};
    }
    case "classroom":
      return await classroomScope(ctx, target.id as Id<"classrooms">);
    case "classroom_teacher": {
      const assignment = await ctx.db.get(target.id as Id<"classroomTeachers">);
      return assignment ? await classroomScope(ctx, assignment.classroomId) : {};
    }
    case "enrollment": {
      const enrollment = await ctx.db.get(target.id as Id<"enrollments">);
      return enrollment ? await classroomScope(ctx, enrollment.classroomId) : {};
    }
    case "assignment": {
      const assignment = await ctx.db.get(target.id as Id<"assignments">);
      return assignment ? { courseId: assignment.courseId } : {};
    }
    case "assignment_version": {
      const version = await ctx.db.get(target.id as Id<"assignmentVersions">);
      const assignment = version ? await ctx.db.get(version.assignmentId) : null;
      return assignment ? { courseId: assignment.courseId } : {};
    }
    case "assignment_release":
      return await releaseScope(ctx, await ctx.db.get(target.id as Id<"assignmentReleases">));
    case "deadline_exception": {
      const exception = await ctx.db.get(target.id as Id<"deadlineExceptions">);
      return await releaseScope(
        ctx,
        exception ? await ctx.db.get(exception.assignmentReleaseId) : null,
      );
    }
    case "assignment_excuse": {
      const excuse = await ctx.db.get(target.id as Id<"assignmentExcuses">);
      return await releaseScope(ctx, excuse ? await ctx.db.get(excuse.assignmentReleaseId) : null);
    }
    case "grade_return": {
      const gradeReturn = await ctx.db.get(target.id as Id<"gradeReturns">);
      return await releaseScope(
        ctx,
        gradeReturn ? await ctx.db.get(gradeReturn.assignmentReleaseId) : null,
      );
    }
    case "workspace": {
      const workspace = await ctx.db.get(target.id as Id<"workspaces">);
      return await releaseScope(
        ctx,
        workspace ? await ctx.db.get(workspace.assignmentReleaseId) : null,
      );
    }
    case "material": {
      const material = await ctx.db.get(target.id as Id<"materials">);
      return material ? { courseId: material.courseId } : {};
    }
    case "material_version": {
      const version = await ctx.db.get(target.id as Id<"materialVersions">);
      const material = version ? await ctx.db.get(version.materialId) : null;
      return material ? { courseId: material.courseId } : {};
    }
    case "material_release":
      return await releaseScope(ctx, await ctx.db.get(target.id as Id<"materialReleases">));
  }
}

export async function appendAuditEvent(ctx: MutationCtx, event: AuditEvent) {
  const scope = await scopeForTarget(ctx, event.target);
  return await ctx.db.insert("auditEvents", {
    organizationId: event.organizationId,
    ...scope,
    actorKind: event.actor.kind,
    actorUserId: event.actor.kind === "user" ? event.actor.userId : undefined,
    action: event.action,
    targetKind: event.target.kind,
    targetId: event.target.id,
    occurredAt: Date.now(),
  });
}

function newestFirst(left: Doc<"auditEvents">, right: Doc<"auditEvents">) {
  return right.occurredAt - left.occurredAt || right._creationTime - left._creationTime;
}

async function presentEvents(ctx: Parameters<typeof requireRole>[0], events: Doc<"auditEvents">[]) {
  const actors = new Map<Id<"users">, Pick<Doc<"users">, "displayName" | "username">>();
  await Promise.all(
    [...new Set(events.flatMap(({ actorUserId }) => (actorUserId ? [actorUserId] : [])))].map(
      async (userId) => {
        const user = await ctx.db.get(userId);
        if (user) actors.set(userId, user);
      },
    ),
  );
  return events.map((event) => {
    const actor = event.actorUserId ? actors.get(event.actorUserId) : undefined;
    return {
      id: event._id,
      action: event.action,
      actor:
        event.actorKind === "developer"
          ? { kind: "developer" as const }
          : {
              kind: "user" as const,
              id: event.actorUserId,
              displayName: actor?.displayName ?? "Former user",
              username: actor?.username,
            },
      organizationId: event.organizationId,
      courseId: event.courseId,
      classroomId: event.classroomId,
      resource: { kind: event.targetKind, id: event.targetId },
      occurredAt: event.occurredAt,
    };
  });
}

function queryLimit(value: number | undefined) {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw new ConvexError("Audit Event limit must be a positive integer");
  }
  return Math.min(value ?? 100, 200);
}

export const listMine = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit: requestedLimit }) => {
    const { organization, user } = await requireRole(ctx, "teacher");
    const limit = queryLimit(requestedLimit);
    const [courseAssignments, classroomAssignments] = await Promise.all([
      ctx.db
        .query("courseCollaborators")
        .withIndex("by_teacher", (index) => index.eq("teacherId", user._id))
        .collect(),
      ctx.db
        .query("classroomTeachers")
        .withIndex("by_teacher", (index) => index.eq("teacherId", user._id))
        .collect(),
    ]);
    const groups = await Promise.all([
      ...courseAssignments.map(({ courseId }) =>
        ctx.db
          .query("auditEvents")
          .withIndex("by_organization_course", (index) =>
            index.eq("organizationId", organization._id).eq("courseId", courseId),
          )
          .filter((filter) => filter.eq(filter.field("classroomId"), undefined))
          .order("desc")
          .take(limit),
      ),
      ...classroomAssignments.map(({ classroomId }) =>
        ctx.db
          .query("auditEvents")
          .withIndex("by_organization_classroom", (index) =>
            index.eq("organizationId", organization._id).eq("classroomId", classroomId),
          )
          .order("desc")
          .take(limit),
      ),
    ]);
    const unique = new Map(groups.flat().map((event) => [event._id, event]));
    return await presentEvents(ctx, [...unique.values()].sort(newestFirst).slice(0, limit));
  },
});

export const listOrganization = internalQuery({
  args: { organizationId: v.id("organizations"), limit: v.optional(v.number()) },
  handler: async (ctx, { organizationId, limit: requestedLimit }) => {
    const organization = await ctx.db.get(organizationId);
    if (!organization) throw new ConvexError("Organization not found");
    const events = await ctx.db
      .query("auditEvents")
      .withIndex("by_organization", (index) => index.eq("organizationId", organizationId))
      .order("desc")
      .take(queryLimit(requestedLimit));
    return await presentEvents(ctx, events.sort(newestFirst));
  },
});
