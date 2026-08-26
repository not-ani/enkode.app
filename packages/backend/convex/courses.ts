import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { appendAuditEvent } from "./audit";
import { requireCourseCollaborator, requireRole } from "./authorization";

const courseFields = {
  name: v.string(),
  description: v.optional(v.string()),
};

function cleanRequired(value: string, label: string) {
  const cleaned = value.trim();
  if (!cleaned) {
    throw new ConvexError(`${label} is required`);
  }
  return cleaned;
}

function cleanOptional(value: string | undefined) {
  const cleaned = value?.trim();
  return cleaned || undefined;
}

async function getCollaborators(
  ctx: Parameters<typeof requireCourseCollaborator>[0],
  courseId: Parameters<typeof requireCourseCollaborator>[1],
) {
  const assignments = await ctx.db
    .query("courseCollaborators")
    .withIndex("by_course", (index) => index.eq("courseId", courseId))
    .collect();
  return await Promise.all(
    assignments.map(async (assignment) => {
      const teacher = await ctx.db.get(assignment.teacherId);
      if (!teacher) {
        throw new ConvexError("Assigned Teacher is unavailable");
      }
      return {
        id: assignment._id,
        teacherId: teacher._id,
        displayName: teacher.displayName,
        username: teacher.username,
      };
    }),
  );
}

export const create = mutation({
  args: courseFields,
  handler: async (ctx, args) => {
    const { organization, user } = await requireRole(ctx, "teacher");
    const courseId = await ctx.db.insert("courses", {
      organizationId: organization._id,
      name: cleanRequired(args.name, "Course name"),
      description: cleanOptional(args.description),
    });
    const assignmentId = await ctx.db.insert("courseCollaborators", {
      organizationId: organization._id,
      courseId,
      teacherId: user._id,
    });

    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "course.created",
      target: { kind: "course", id: courseId },
    });
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "course_collaborator.assigned",
      target: { kind: "course_collaborator", id: assignmentId },
    });

    return courseId;
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireRole(ctx, "teacher");
    const assignments = await ctx.db
      .query("courseCollaborators")
      .withIndex("by_teacher", (index) => index.eq("teacherId", user._id))
      .collect();
    const courses = await Promise.all(
      assignments.map(async ({ courseId }) => {
        const course = await ctx.db.get(courseId);
        if (!course) return null;
        return { ...course, collaborators: await getCollaborators(ctx, courseId) };
      }),
    );
    return courses
      .filter((course) => course !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  },
});

export const get = query({
  args: { courseId: v.id("courses") },
  handler: async (ctx, { courseId }) => {
    const { course } = await requireCourseCollaborator(ctx, courseId);
    return { ...course, collaborators: await getCollaborators(ctx, courseId) };
  },
});

export const update = mutation({
  args: { courseId: v.id("courses"), ...courseFields },
  handler: async (ctx, { courseId, ...changes }) => {
    const { course, organization, user } = await requireCourseCollaborator(ctx, courseId);
    await ctx.db.patch(course._id, {
      name: cleanRequired(changes.name, "Course name"),
      description: cleanOptional(changes.description),
    });
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "course.updated",
      target: { kind: "course", id: courseId },
    });
  },
});

export const addCollaborator = mutation({
  args: { courseId: v.id("courses"), username: v.string() },
  handler: async (ctx, { courseId, username }) => {
    const { organization, user } = await requireCourseCollaborator(ctx, courseId);
    const teacher = await ctx.db
      .query("users")
      .withIndex("by_organization_username", (index) =>
        index.eq("organizationId", organization._id).eq("username", username.trim()),
      )
      .unique();
    if (!teacher || teacher.role !== "teacher") {
      throw new ConvexError("Teacher not found");
    }

    const existing = await ctx.db
      .query("courseCollaborators")
      .withIndex("by_course_teacher", (index) =>
        index.eq("courseId", courseId).eq("teacherId", teacher._id),
      )
      .unique();
    if (existing) return existing._id;

    const assignmentId = await ctx.db.insert("courseCollaborators", {
      organizationId: organization._id,
      courseId,
      teacherId: teacher._id,
    });
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "course_collaborator.assigned",
      target: { kind: "course_collaborator", id: assignmentId },
    });
    return assignmentId;
  },
});

export const removeCollaborator = mutation({
  args: { courseId: v.id("courses"), teacherId: v.id("users") },
  handler: async (ctx, { courseId, teacherId }) => {
    const { organization, user } = await requireCourseCollaborator(ctx, courseId);
    const assignment = await ctx.db
      .query("courseCollaborators")
      .withIndex("by_course_teacher", (index) =>
        index.eq("courseId", courseId).eq("teacherId", teacherId),
      )
      .unique();
    if (!assignment || assignment.organizationId !== organization._id) {
      throw new ConvexError("Course Collaborator assignment not found");
    }
    const collaborators = await ctx.db
      .query("courseCollaborators")
      .withIndex("by_course", (index) => index.eq("courseId", courseId))
      .take(2);
    if (collaborators.length === 1) {
      throw new ConvexError("A Course needs at least one Course Collaborator");
    }

    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "course_collaborator.unassigned",
      target: { kind: "course_collaborator", id: assignment._id },
    });
    await ctx.db.delete(assignment._id);
  },
});
