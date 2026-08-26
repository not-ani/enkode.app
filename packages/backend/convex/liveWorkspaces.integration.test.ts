import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { VIEWER_PRESENCE_TTL_MS } from "./liveWorkspaces";

const modules = import.meta.glob("./**/*.ts");

function createTestBackend() {
  return convexTest(schema, modules);
}

const assignmentVersion = {
  instructions: "Print hello.",
  runtimeVersion: "3.12.0",
  entrypoint: "main.py",
  starterFiles: [{ path: "main.py", content: "print('hello')\n" }],
  evaluationTests: [],
};

async function seed(backend: ReturnType<typeof createTestBackend>) {
  const ids = await backend.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      name: "North Academy",
      slug: "north",
    });
    const teacherId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-teacher",
      username: "teacher",
      displayName: "Ada Teacher",
      role: "teacher",
    });
    await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-unassigned",
      username: "unassigned",
      displayName: "Unassigned Teacher",
      role: "teacher",
    });
    const studentId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-student",
      username: "student",
      displayName: "Grace Student",
      role: "student",
    });
    await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-other-student",
      username: "other",
      displayName: "Other Student",
      role: "student",
    });
    return { studentId, teacherId };
  });
  const teacher = backend.withIdentity({ subject: "auth-teacher" });
  const student = backend.withIdentity({ subject: "auth-student" });
  const courseId = await teacher.mutation(api.courses.create, { name: "CS101" });
  const classroomId = await teacher.mutation(api.classrooms.create, { courseId, name: "Period 1" });
  const assignment = await teacher.mutation(api.assignments.create, {
    courseId,
    title: "Greeting",
    ...assignmentVersion,
  });
  const enrollmentId = await teacher.mutation(api.enrollments.enroll, {
    classroomId,
    studentId: ids.studentId,
  });
  const assignmentReleaseId = await teacher.mutation(api.assignmentReleases.create, {
    classroomId,
    assignmentVersionId: assignment.assignmentVersionId,
    points: 10,
  });
  const workspace = await student.mutation(api.workspaces.open, { assignmentReleaseId });
  return { ...ids, assignmentReleaseId, classroomId, enrollmentId, student, teacher, workspace };
}

describe("live Workspace viewing", () => {
  afterEach(() => vi.useRealTimers());

  it("lets an assigned Classroom Teacher follow committed files without edit access", async () => {
    const backend = createTestBackend();
    const { student, teacher, workspace } = await seed(backend);

    await teacher.mutation(api.liveWorkspaces.enter, {
      workspaceId: workspace._id,
      sessionId: "teacher-tab",
    });
    expect(
      await teacher.query(api.liveWorkspaces.watch, {
        workspaceId: workspace._id,
        sessionId: "teacher-tab",
      }),
    ).toMatchObject({
      files: assignmentVersion.starterFiles,
      studentDisplayName: "Grace Student",
    });

    const committed = [{ path: "main.py", content: "print('committed')\n" }];
    await student.mutation(api.workspaces.save, { workspaceId: workspace._id, files: committed });
    expect(
      await teacher.query(api.liveWorkspaces.watch, {
        workspaceId: workspace._id,
        sessionId: "teacher-tab",
      }),
    ).toMatchObject({
      files: committed,
    });
    await expect(
      teacher.mutation(api.workspaces.save, { workspaceId: workspace._id, files: committed }),
    ).rejects.toThrow("Forbidden");
  });

  it("shows the named Teacher to only the owning Student and records immutable access", async () => {
    const backend = createTestBackend();
    const { student, teacher, teacherId, workspace } = await seed(backend);

    await teacher.mutation(api.liveWorkspaces.enter, {
      workspaceId: workspace._id,
      sessionId: "teacher-tab",
    });
    await teacher.mutation(api.liveWorkspaces.enter, {
      workspaceId: workspace._id,
      sessionId: "teacher-tab",
    });

    expect(
      await student.query(api.liveWorkspaces.listViewers, { workspaceId: workspace._id }),
    ).toEqual([{ teacherId, displayName: "Ada Teacher" }]);
    await expect(
      backend
        .withIdentity({ subject: "auth-other-student" })
        .query(api.liveWorkspaces.listViewers, {
          workspaceId: workspace._id,
        }),
    ).rejects.toThrow("Forbidden");
    const events = await backend.run(async (ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_target", (index) =>
          index.eq("targetKind", "workspace").eq("targetId", workspace._id),
        )
        .collect(),
    );
    expect(events).toEqual([
      expect.objectContaining({
        action: "workspace.live_view_opened",
        actorUserId: teacherId,
        targetId: workspace._id,
      }),
    ]);
  });

  it("rejects unassigned Teachers, other Students, and ended Enrollments", async () => {
    const backend = createTestBackend();
    const { enrollmentId, teacher, workspace } = await seed(backend);
    const unassigned = backend.withIdentity({ subject: "auth-unassigned" });
    const otherStudent = backend.withIdentity({ subject: "auth-other-student" });

    await expect(
      unassigned.mutation(api.liveWorkspaces.enter, {
        workspaceId: workspace._id,
        sessionId: "unassigned",
      }),
    ).rejects.toThrow("Forbidden");
    await expect(
      otherStudent.query(api.liveWorkspaces.watch, {
        workspaceId: workspace._id,
        sessionId: "student",
      }),
    ).rejects.toThrow("Forbidden");

    await teacher.mutation(api.enrollments.end, { enrollmentId });
    expect(await teacher.query(api.liveWorkspaces.listForTeacher, {})).toEqual([]);
    await expect(
      teacher.query(api.liveWorkspaces.watch, {
        workspaceId: workspace._id,
        sessionId: "teacher-tab",
      }),
    ).rejects.toThrow("Forbidden");
  });

  it("clears presence on leave and after a missed heartbeat timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 26, 18));
    const backend = createTestBackend();
    const { student, teacher, workspace } = await seed(backend);

    await teacher.mutation(api.liveWorkspaces.enter, {
      workspaceId: workspace._id,
      sessionId: "navigation",
    });
    await teacher.mutation(api.liveWorkspaces.leave, {
      workspaceId: workspace._id,
      sessionId: "navigation",
    });
    expect(
      await student.query(api.liveWorkspaces.listViewers, { workspaceId: workspace._id }),
    ).toEqual([]);

    const { expiresAt } = await teacher.mutation(api.liveWorkspaces.enter, {
      workspaceId: workspace._id,
      sessionId: "disconnect",
    });
    const presenceId = await backend.run(
      async (ctx) =>
        (
          await ctx.db
            .query("workspaceViewerPresences")
            .withIndex("by_workspace_session", (index) =>
              index.eq("workspaceId", workspace._id).eq("sessionId", "disconnect"),
            )
            .unique()
        )?._id,
    );
    expect(expiresAt).toBe(Date.now() + VIEWER_PRESENCE_TTL_MS);
    vi.setSystemTime(expiresAt);
    expect(
      await student.query(api.liveWorkspaces.listViewers, { workspaceId: workspace._id }),
    ).toEqual([]);
    await expect(
      teacher.query(api.liveWorkspaces.watch, {
        workspaceId: workspace._id,
        sessionId: "disconnect",
      }),
    ).rejects.toThrow("Viewer session ended");
    await backend.mutation(internal.liveWorkspaces.expire, {
      presenceId: presenceId as Id<"workspaceViewerPresences">,
      expiresAt,
    });
    expect(
      await backend.run(async (ctx) => await ctx.db.query("workspaceViewerPresences").collect()),
    ).toEqual([]);
  });

  it("keeps a heartbeating viewer when an older expiry job runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 26, 18));
    const backend = createTestBackend();
    const { student, teacher, workspace } = await seed(backend);
    const first = await teacher.mutation(api.liveWorkspaces.enter, {
      workspaceId: workspace._id,
      sessionId: "active-view",
    });
    const presenceId = await backend.run(
      async (ctx) =>
        (
          await ctx.db
            .query("workspaceViewerPresences")
            .withIndex("by_workspace_session", (index) =>
              index.eq("workspaceId", workspace._id).eq("sessionId", "active-view"),
            )
            .unique()
        )?._id,
    );

    vi.advanceTimersByTime(20_000);
    const renewed = await teacher.mutation(api.liveWorkspaces.heartbeat, {
      workspaceId: workspace._id,
      sessionId: "active-view",
    });
    vi.setSystemTime(first.expiresAt);
    await backend.mutation(internal.liveWorkspaces.expire, {
      presenceId: presenceId as Id<"workspaceViewerPresences">,
      expiresAt: first.expiresAt,
    });

    expect(renewed.expiresAt).toBeGreaterThan(first.expiresAt);
    expect(
      await student.query(api.liveWorkspaces.listViewers, { workspaceId: workspace._id }),
    ).toEqual([expect.objectContaining({ displayName: "Ada Teacher" })]);
  });

  it("does not revive an expired viewer lease with a late heartbeat", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 26, 18));
    const backend = createTestBackend();
    const { student, teacher, workspace } = await seed(backend);
    const { expiresAt } = await teacher.mutation(api.liveWorkspaces.enter, {
      workspaceId: workspace._id,
      sessionId: "expired-view",
    });

    vi.setSystemTime(expiresAt);
    await expect(
      teacher.mutation(api.liveWorkspaces.heartbeat, {
        workspaceId: workspace._id,
        sessionId: "expired-view",
      }),
    ).rejects.toThrow("Viewer session ended");
    expect(
      await student.query(api.liveWorkspaces.listViewers, { workspaceId: workspace._id }),
    ).toEqual([]);
  });
});
