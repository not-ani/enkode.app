import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api";
import { appendAuditEvent } from "./audit";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seed() {
  const backend = convexTest(schema, modules);
  const data = await backend.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", { name: "North", slug: "north" });
    const otherOrganizationId = await ctx.db.insert("organizations", {
      name: "South",
      slug: "south",
    });
    async function user(
      authUserId: string,
      role: "teacher" | "student",
      organization = organizationId,
    ) {
      return await ctx.db.insert("users", {
        organizationId: organization,
        authUserId,
        username: authUserId,
        displayName: authUserId,
        role,
      });
    }
    const courseTeacherId = await user("course-teacher", "teacher");
    const classroomTeacherId = await user("classroom-teacher", "teacher");
    const unrelatedTeacherId = await user("unrelated-teacher", "teacher");
    const studentId = await user("student", "student");
    const otherTeacherId = await user("other-teacher", "teacher", otherOrganizationId);
    const courseId = await ctx.db.insert("courses", { organizationId, name: "CS101" });
    const classroomId = await ctx.db.insert("classrooms", {
      organizationId,
      courseId,
      name: "Period 1",
    });
    await ctx.db.insert("courseCollaborators", {
      organizationId,
      courseId,
      teacherId: courseTeacherId,
    });
    await ctx.db.insert("classroomTeachers", {
      organizationId,
      classroomId,
      teacherId: classroomTeacherId,
    });
    const otherCourseId = await ctx.db.insert("courses", {
      organizationId: otherOrganizationId,
      name: "CS201",
    });
    return {
      organizationId,
      otherOrganizationId,
      courseTeacherId,
      classroomTeacherId,
      unrelatedTeacherId,
      studentId,
      otherTeacherId,
      courseId,
      classroomId,
      otherCourseId,
    };
  });
  return { backend, ...data };
}

async function record(
  seeded: Awaited<ReturnType<typeof seed>>,
  input: Parameters<typeof appendAuditEvent>[1],
) {
  return await seeded.backend.run(async (ctx) => await appendAuditEvent(ctx, input));
}

beforeEach(() => {
  process.env.SITE_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET = "test-secret-that-is-at-least-32-characters";
  process.env.DEVELOPER_PROVISIONING_SECRET = "developer-test-secret";
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("role-scoped Audit Events", () => {
  it("gives developers the complete Organization chronology without credentials", async () => {
    const seeded = await seed();
    vi.setSystemTime(10);
    await record(seeded, {
      organizationId: seeded.organizationId,
      actor: { kind: "developer" },
      action: "user.password_reset",
      target: { kind: "user", id: seeded.studentId },
    });
    vi.setSystemTime(20);
    await record(seeded, {
      organizationId: seeded.organizationId,
      actor: { kind: "user", userId: seeded.courseTeacherId },
      action: "course.updated",
      target: { kind: "course", id: seeded.courseId },
    });
    vi.setSystemTime(30);
    await record(seeded, {
      organizationId: seeded.organizationId,
      actor: { kind: "user", userId: seeded.classroomTeacherId },
      action: "classroom.updated",
      target: { kind: "classroom", id: seeded.classroomId },
    });
    vi.setSystemTime(40);
    await record(seeded, {
      organizationId: seeded.otherOrganizationId,
      actor: { kind: "user", userId: seeded.otherTeacherId },
      action: "course.updated",
      target: { kind: "course", id: seeded.otherCourseId },
    });

    const response = await seeded.backend.fetch(
      `/api/developer/audit-events?organizationId=${seeded.organizationId}`,
      { headers: { authorization: "Bearer developer-test-secret" } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { events: Record<string, unknown>[] };
    expect(body.events.map(({ action }) => action)).toEqual([
      "classroom.updated",
      "course.updated",
      "user.password_reset",
    ]);
    expect(body.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: expect.any(String),
          actor: expect.any(Object),
          organizationId: seeded.organizationId,
          resource: expect.objectContaining({ id: expect.any(String), kind: expect.any(String) }),
          occurredAt: expect.any(Number),
        }),
      ]),
    );
    expect(body.events.flatMap((event) => Object.keys(event))).not.toEqual(
      expect.arrayContaining(["password", "credential", "secret"]),
    );

    const denied = await seeded.backend.fetch(
      `/api/developer/audit-events?organizationId=${seeded.organizationId}`,
    );
    expect(denied.status).toBe(404);
  });

  it("limits Teachers to explicitly managed resources, including archived resources", async () => {
    const seeded = await seed();
    await record(seeded, {
      organizationId: seeded.organizationId,
      actor: { kind: "user", userId: seeded.courseTeacherId },
      action: "course.archived",
      target: { kind: "course", id: seeded.courseId },
    });
    await record(seeded, {
      organizationId: seeded.organizationId,
      actor: { kind: "user", userId: seeded.classroomTeacherId },
      action: "workspace.live_view_opened",
      target: { kind: "classroom", id: seeded.classroomId },
    });
    await record(seeded, {
      organizationId: seeded.organizationId,
      actor: { kind: "developer" },
      action: "user.student_role_assigned",
      target: { kind: "user", id: seeded.studentId },
    });
    await seeded.backend.run(async (ctx) => {
      await ctx.db.patch(seeded.courseId, { archivedAt: 1, archivedBy: seeded.courseTeacherId });
      await ctx.db.patch(seeded.classroomId, {
        archivedAt: 1,
        archivedBy: seeded.classroomTeacherId,
      });
    });

    const courseEvents = await seeded.backend
      .withIdentity({ subject: "course-teacher" })
      .query(api.audit.listMine, {});
    expect(courseEvents.map(({ action }: { action: string }) => action)).toEqual([
      "course.archived",
    ]);
    const classroomEvents = await seeded.backend
      .withIdentity({ subject: "classroom-teacher" })
      .query(api.audit.listMine, {});
    expect(classroomEvents.map(({ action }: { action: string }) => action)).toEqual([
      "workspace.live_view_opened",
    ]);
    expect(
      await seeded.backend
        .withIdentity({ subject: "unrelated-teacher" })
        .query(api.audit.listMine, {}),
    ).toEqual([]);
    await expect(
      seeded.backend.withIdentity({ subject: "student" }).query(api.audit.listMine, {}),
    ).rejects.toThrow("Forbidden");
  });

  it("snapshots Classroom scope for academic events and never inserts Work History", async () => {
    const seeded = await seed();
    const ids = await seeded.backend.run(async (ctx) => {
      const assignmentId = await ctx.db.insert("assignments", {
        organizationId: seeded.organizationId,
        courseId: seeded.courseId,
        title: "Hello",
        latestVersion: 1,
      });
      const assignmentVersionId = await ctx.db.insert("assignmentVersions", {
        organizationId: seeded.organizationId,
        assignmentId,
        version: 1,
        instructions: "Hello",
        language: "python",
        runtimeVersion: "3.12.0",
        entrypoint: "main.py",
        createdBy: seeded.courseTeacherId,
        createdAt: 1,
      });
      const releaseId = await ctx.db.insert("assignmentReleases", {
        organizationId: seeded.organizationId,
        classroomId: seeded.classroomId,
        assignmentId,
        assignmentVersionId,
        points: 10,
        order: 0,
        createdBy: seeded.classroomTeacherId,
        createdAt: 1,
      });
      const enrollmentId = await ctx.db.insert("enrollments", {
        organizationId: seeded.organizationId,
        classroomId: seeded.classroomId,
        studentId: seeded.studentId,
        status: "active",
      });
      const exceptionId = await ctx.db.insert("deadlineExceptions", {
        organizationId: seeded.organizationId,
        assignmentReleaseId: releaseId,
        studentId: seeded.studentId,
        deadlinePolicy: "accept_late",
        updatedBy: seeded.classroomTeacherId,
        createdAt: 1,
        updatedAt: 1,
      });
      return { releaseId, enrollmentId, exceptionId };
    });
    for (const [action, kind, id] of [
      ["enrollment.enrolled", "enrollment", ids.enrollmentId],
      ["assignment_release.published", "assignment_release", ids.releaseId],
      ["deadline_exception.changed", "deadline_exception", ids.exceptionId],
    ] as const) {
      await record(seeded, {
        organizationId: seeded.organizationId,
        actor: { kind: "user", userId: seeded.classroomTeacherId },
        action,
        target: { kind, id },
      });
    }
    const before = await seeded.backend.run((ctx) => ctx.db.query("auditEvents").collect());
    await record(seeded, {
      organizationId: seeded.organizationId,
      actor: { kind: "user", userId: seeded.classroomTeacherId },
      action: "deadline_exception.removed",
      target: { kind: "deadline_exception", id: ids.exceptionId },
    });
    const after = await seeded.backend.run((ctx) => ctx.db.query("auditEvents").collect());

    expect(after.every(({ courseId }) => courseId === seeded.courseId)).toBe(true);
    expect(after.every(({ classroomId }) => classroomId === seeded.classroomId)).toBe(true);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(await seeded.backend.run((ctx) => ctx.db.query("workHistoryChunks").collect())).toEqual(
      [],
    );
  });
});
