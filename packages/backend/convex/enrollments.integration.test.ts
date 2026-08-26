import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTestBackend() {
  return convexTest(schema, modules);
}

async function seedEnrollmentContext(backend: ReturnType<typeof createTestBackend>) {
  const ids = await backend.run(async (ctx) => {
    const northId = await ctx.db.insert("organizations", {
      name: "North Academy",
      slug: "north",
    });
    const southId = await ctx.db.insert("organizations", {
      name: "South Academy",
      slug: "south",
    });
    const teacherId = await ctx.db.insert("users", {
      organizationId: northId,
      authUserId: "auth-teacher",
      username: "teacher",
      displayName: "Classroom Teacher",
      role: "teacher",
    });
    await ctx.db.insert("users", {
      organizationId: northId,
      authUserId: "auth-unassigned",
      username: "unassigned",
      displayName: "Unassigned Teacher",
      role: "teacher",
    });
    const studentId = await ctx.db.insert("users", {
      organizationId: northId,
      authUserId: "auth-student",
      username: "student",
      displayName: "North Student",
      role: "student",
    });
    const otherStudentId = await ctx.db.insert("users", {
      organizationId: southId,
      authUserId: "auth-other-student",
      username: "student",
      displayName: "South Student",
      role: "student",
    });
    return { northId, otherStudentId, studentId, teacherId };
  });
  const teacher = backend.withIdentity({ subject: "auth-teacher" });
  const courseId = await teacher.mutation(api.courses.create, { name: "CS101" });
  const classroomId = await teacher.mutation(api.classrooms.create, {
    courseId,
    name: "Period 1",
  });
  return { ...ids, classroomId, teacher };
}

describe("Classroom Enrollments", () => {
  it("enrolls a same-Organization Student and grants active Classroom access", async () => {
    const backend = createTestBackend();
    const { classroomId, studentId, teacher } = await seedEnrollmentContext(backend);

    const enrollmentId = await teacher.mutation(api.enrollments.enroll, {
      classroomId,
      studentId,
    });

    expect(await teacher.query(api.enrollments.listForClassroom, { classroomId })).toEqual([
      expect.objectContaining({ id: enrollmentId, studentId, status: "active" }),
    ]);
    expect(
      await backend.withIdentity({ subject: "auth-student" }).query(api.enrollments.listMine, {}),
    ).toEqual([
      expect.objectContaining({
        classroomId,
        classroomName: "Period 1",
        courseName: "CS101",
        enrollmentId,
      }),
    ]);
  });

  it("rejects Students outside the Classroom Organization", async () => {
    const backend = createTestBackend();
    const { classroomId, otherStudentId, teacher } = await seedEnrollmentContext(backend);

    await expect(
      teacher.mutation(api.enrollments.enroll, {
        classroomId,
        studentId: otherStudentId,
      }),
    ).rejects.toThrow("Student not found in this organization");
  });

  it("ends and restores one durable Enrollment identity", async () => {
    const backend = createTestBackend();
    const { classroomId, studentId, teacher } = await seedEnrollmentContext(backend);
    const enrollmentId = await teacher.mutation(api.enrollments.enroll, {
      classroomId,
      studentId,
    });
    const student = backend.withIdentity({ subject: "auth-student" });

    await teacher.mutation(api.enrollments.end, { enrollmentId });
    expect(await student.query(api.enrollments.listMine, {})).toEqual([]);
    const ended = await backend.run(
      async (ctx) =>
        await ctx.db
          .query("enrollments")
          .filter((query) => query.eq(query.field("_id"), enrollmentId))
          .unique(),
    );
    expect(ended).toMatchObject({ classroomId, studentId, status: "ended" });
    expect(ended?.endedAt).toEqual(expect.any(Number));
    await expect(
      teacher.mutation(api.enrollments.enroll, { classroomId, studentId }),
    ).rejects.toThrow("Restore the ended Enrollment instead");

    await teacher.mutation(api.enrollments.restore, { enrollmentId });
    expect(await student.query(api.enrollments.listMine, {})).toEqual([
      expect.objectContaining({ enrollmentId }),
    ]);
    const restored = await backend.run(
      async (ctx) =>
        await ctx.db
          .query("enrollments")
          .filter((query) => query.eq(query.field("_id"), enrollmentId))
          .unique(),
    );
    expect(restored).toMatchObject({ classroomId, studentId, status: "active" });
    expect(restored?.endedAt).toBeUndefined();
    expect(
      await backend.run(async (ctx) => await ctx.db.query("enrollments").collect()),
    ).toHaveLength(1);
  });

  it("allows only assigned Classroom Teachers to change Enrollments", async () => {
    const backend = createTestBackend();
    const { classroomId, studentId, teacher } = await seedEnrollmentContext(backend);
    const unassigned = backend.withIdentity({ subject: "auth-unassigned" });

    await expect(
      unassigned.mutation(api.enrollments.enroll, { classroomId, studentId }),
    ).rejects.toThrow("Forbidden");
    await expect(
      backend.withIdentity({ subject: "auth-student" }).query(api.enrollments.listForClassroom, {
        classroomId,
      }),
    ).rejects.toThrow("Forbidden");

    const enrollmentId = await teacher.mutation(api.enrollments.enroll, {
      classroomId,
      studentId,
    });
    await expect(unassigned.mutation(api.enrollments.end, { enrollmentId })).rejects.toThrow(
      "Forbidden",
    );
    await teacher.mutation(api.enrollments.end, { enrollmentId });
    await expect(unassigned.mutation(api.enrollments.restore, { enrollmentId })).rejects.toThrow(
      "Forbidden",
    );
  });

  it("emits immutable audit events for enroll, end, and restore", async () => {
    const backend = createTestBackend();
    const { classroomId, studentId, teacher, teacherId } = await seedEnrollmentContext(backend);
    const enrollmentId = await teacher.mutation(api.enrollments.enroll, {
      classroomId,
      studentId,
    });
    await teacher.mutation(api.enrollments.end, { enrollmentId });
    await teacher.mutation(api.enrollments.restore, { enrollmentId });

    const events = await backend.run(
      async (ctx) =>
        await ctx.db
          .query("auditEvents")
          .withIndex("by_target", (index) =>
            index.eq("targetKind", "enrollment").eq("targetId", enrollmentId),
          )
          .collect(),
    );
    expect(events.map(({ action }) => action)).toEqual([
      "enrollment.enrolled",
      "enrollment.ended",
      "enrollment.restored",
    ]);
    expect(events.every(({ actorUserId }) => actorUserId === teacherId)).toBe(true);
    expect(new Set(events.map(({ _id }) => _id)).size).toBe(3);
  });
});
