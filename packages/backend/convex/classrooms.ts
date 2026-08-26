import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { appendAuditEvent } from "./audit";
import { requireClassroomTeacher, requireCourseCollaborator, requireRole } from "./authorization";

function cleanName(name: string) {
  const cleaned = name.trim();
  if (!cleaned) throw new ConvexError("Classroom name is required");
  return cleaned;
}

async function getTeachers(
  ctx: Parameters<typeof requireClassroomTeacher>[0],
  classroomId: Parameters<typeof requireClassroomTeacher>[1],
) {
  const assignments = await ctx.db
    .query("classroomTeachers")
    .withIndex("by_classroom", (index) => index.eq("classroomId", classroomId))
    .collect();
  return await Promise.all(
    assignments.map(async (assignment) => {
      const teacher = await ctx.db.get(assignment.teacherId);
      if (!teacher) throw new ConvexError("Assigned Teacher is unavailable");
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
  args: { courseId: v.id("courses"), name: v.string() },
  handler: async (ctx, { courseId, name }) => {
    const { organization, user } = await requireCourseCollaborator(ctx, courseId);
    const classroomId = await ctx.db.insert("classrooms", {
      organizationId: organization._id,
      courseId,
      name: cleanName(name),
    });
    const assignmentId = await ctx.db.insert("classroomTeachers", {
      organizationId: organization._id,
      classroomId,
      teacherId: user._id,
    });

    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "classroom.created",
      target: { kind: "classroom", id: classroomId },
    });
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "classroom_teacher.assigned",
      target: { kind: "classroom_teacher", id: assignmentId },
    });
    return classroomId;
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireRole(ctx, "teacher");
    const assignments = await ctx.db
      .query("classroomTeachers")
      .withIndex("by_teacher", (index) => index.eq("teacherId", user._id))
      .collect();
    const classrooms = await Promise.all(
      assignments.map(async ({ classroomId }) => {
        const classroom = await ctx.db.get(classroomId);
        if (!classroom) return null;
        const course = await ctx.db.get(classroom.courseId);
        if (!course) return null;
        return {
          ...classroom,
          courseName: course.name,
          teachers: await getTeachers(ctx, classroomId),
        };
      }),
    );
    return classrooms
      .filter((classroom) => classroom !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  },
});

export const get = query({
  args: { classroomId: v.id("classrooms") },
  handler: async (ctx, { classroomId }) => {
    const { classroom } = await requireClassroomTeacher(ctx, classroomId);
    const course = await ctx.db.get(classroom.courseId);
    if (!course) throw new ConvexError("Course is unavailable");
    return {
      ...classroom,
      course: { id: course._id, name: course.name },
      teachers: await getTeachers(ctx, classroomId),
    };
  },
});

export const update = mutation({
  args: { classroomId: v.id("classrooms"), name: v.string() },
  handler: async (ctx, { classroomId, name }) => {
    const { classroom, organization, user } = await requireClassroomTeacher(ctx, classroomId);
    await ctx.db.patch(classroom._id, { name: cleanName(name) });
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "classroom.updated",
      target: { kind: "classroom", id: classroomId },
    });
  },
});

export const addTeacher = mutation({
  args: { classroomId: v.id("classrooms"), username: v.string() },
  handler: async (ctx, { classroomId, username }) => {
    const { organization, user } = await requireClassroomTeacher(ctx, classroomId);
    const teacher = await ctx.db
      .query("users")
      .withIndex("by_organization_username", (index) =>
        index.eq("organizationId", organization._id).eq("username", username.trim()),
      )
      .unique();
    if (!teacher || teacher.role !== "teacher") throw new ConvexError("Teacher not found");

    const existing = await ctx.db
      .query("classroomTeachers")
      .withIndex("by_classroom_teacher", (index) =>
        index.eq("classroomId", classroomId).eq("teacherId", teacher._id),
      )
      .unique();
    if (existing) return existing._id;

    const assignmentId = await ctx.db.insert("classroomTeachers", {
      organizationId: organization._id,
      classroomId,
      teacherId: teacher._id,
    });
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "classroom_teacher.assigned",
      target: { kind: "classroom_teacher", id: assignmentId },
    });
    return assignmentId;
  },
});

export const removeTeacher = mutation({
  args: { classroomId: v.id("classrooms"), teacherId: v.id("users") },
  handler: async (ctx, { classroomId, teacherId }) => {
    const { organization, user } = await requireClassroomTeacher(ctx, classroomId);
    const assignment = await ctx.db
      .query("classroomTeachers")
      .withIndex("by_classroom_teacher", (index) =>
        index.eq("classroomId", classroomId).eq("teacherId", teacherId),
      )
      .unique();
    if (!assignment || assignment.organizationId !== organization._id) {
      throw new ConvexError("Classroom Teacher assignment not found");
    }
    const teachers = await ctx.db
      .query("classroomTeachers")
      .withIndex("by_classroom", (index) => index.eq("classroomId", classroomId))
      .take(2);
    if (teachers.length === 1) {
      throw new ConvexError("A Classroom needs at least one Classroom Teacher");
    }

    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "classroom_teacher.unassigned",
      target: { kind: "classroom_teacher", id: assignment._id },
    });
    await ctx.db.delete(assignment._id);
  },
});
