import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { appendAuditEvent } from "./audit";
import { requireClassroomTeacher, requireRole } from "./authorization";
import { requireWritableClassroom } from "./lifecycleGuards";

export const listForClassroom = query({
  args: { classroomId: v.id("classrooms") },
  handler: async (ctx, { classroomId }) => {
    await requireClassroomTeacher(ctx, classroomId);
    const enrollments = await ctx.db
      .query("enrollments")
      .withIndex("by_classroom", (index) => index.eq("classroomId", classroomId))
      .collect();

    const rows = await Promise.all(
      enrollments.map(async (enrollment) => {
        const student = await ctx.db.get(enrollment.studentId);
        if (!student || student.role !== "student") {
          throw new ConvexError("Enrolled Student is unavailable");
        }
        return {
          id: enrollment._id,
          studentId: student._id,
          displayName: student.displayName,
          username: student.username,
          status: enrollment.status,
          endedAt: enrollment.endedAt,
        };
      }),
    );

    return rows.sort((left, right) => left.username.localeCompare(right.username));
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

    const classrooms = await Promise.all(
      enrollments.map(async (enrollment) => {
        const classroom = await ctx.db.get(enrollment.classroomId);
        if (
          !classroom ||
          classroom.organizationId !== user.organizationId ||
          classroom.archivedAt !== undefined
        )
          return null;
        const course = await ctx.db.get(classroom.courseId);
        if (
          !course ||
          course.organizationId !== user.organizationId ||
          course.archivedAt !== undefined
        )
          return null;
        return {
          enrollmentId: enrollment._id,
          classroomId: classroom._id,
          classroomName: classroom.name,
          courseName: course.name,
        };
      }),
    );

    return classrooms
      .filter((classroom) => classroom !== null)
      .sort((left, right) => left.classroomName.localeCompare(right.classroomName));
  },
});

export const enroll = mutation({
  args: { classroomId: v.id("classrooms"), studentId: v.id("users") },
  handler: async (ctx, { classroomId, studentId }) => {
    const { organization, user } = await requireClassroomTeacher(ctx, classroomId);
    await requireWritableClassroom(ctx, classroomId);
    const student = await ctx.db.get(studentId);
    if (!student || student.role !== "student" || student.organizationId !== organization._id) {
      throw new ConvexError("Student not found in this organization");
    }

    const existing = await ctx.db
      .query("enrollments")
      .withIndex("by_classroom_student", (index) =>
        index.eq("classroomId", classroomId).eq("studentId", studentId),
      )
      .unique();
    if (existing) {
      throw new ConvexError(
        existing.status === "active"
          ? "Student is already enrolled"
          : "Restore the ended Enrollment instead",
      );
    }

    const enrollmentId = await ctx.db.insert("enrollments", {
      organizationId: organization._id,
      classroomId,
      studentId,
      status: "active",
    });
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "enrollment.enrolled",
      target: { kind: "enrollment", id: enrollmentId },
    });
    return enrollmentId;
  },
});

export const end = mutation({
  args: { enrollmentId: v.id("enrollments") },
  handler: async (ctx, { enrollmentId }) => {
    const enrollment = await ctx.db.get(enrollmentId);
    if (!enrollment) throw new ConvexError("Enrollment not found");
    const { organization, user } = await requireClassroomTeacher(ctx, enrollment.classroomId);
    await requireWritableClassroom(ctx, enrollment.classroomId);
    if (enrollment.organizationId !== organization._id) throw new ConvexError("Forbidden");
    if (enrollment.status !== "active") throw new ConvexError("Enrollment is already ended");

    await ctx.db.patch(enrollmentId, { status: "ended", endedAt: Date.now() });
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "enrollment.ended",
      target: { kind: "enrollment", id: enrollmentId },
    });
  },
});

export const restore = mutation({
  args: { enrollmentId: v.id("enrollments") },
  handler: async (ctx, { enrollmentId }) => {
    const enrollment = await ctx.db.get(enrollmentId);
    if (!enrollment) throw new ConvexError("Enrollment not found");
    const { organization, user } = await requireClassroomTeacher(ctx, enrollment.classroomId);
    await requireWritableClassroom(ctx, enrollment.classroomId);
    if (enrollment.organizationId !== organization._id) throw new ConvexError("Forbidden");
    if (enrollment.status !== "ended") throw new ConvexError("Enrollment is already active");

    await ctx.db.patch(enrollmentId, { status: "active", endedAt: undefined });
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "enrollment.restored",
      target: { kind: "enrollment", id: enrollmentId },
    });
  },
});
