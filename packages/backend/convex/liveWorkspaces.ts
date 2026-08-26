import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { appendAuditEvent } from "./audit";
import { requireClassroomTeacher, requireRole } from "./authorization";
import { requireWritableAssignmentRelease } from "./lifecycleGuards";

export const VIEWER_PRESENCE_TTL_MS = 45_000;

async function requireActiveWorkspaceStudent(
  ctx: Parameters<typeof requireClassroomTeacher>[0],
  workspace: Doc<"workspaces">,
) {
  const release = await ctx.db.get(workspace.assignmentReleaseId);
  if (!release) throw new ConvexError("Workspace Assignment Release is unavailable");
  await requireWritableAssignmentRelease(ctx, release._id);
  const authenticated = await requireClassroomTeacher(ctx, release.classroomId);
  if (workspace.organizationId !== authenticated.organization._id) {
    throw new ConvexError("Forbidden");
  }
  const enrollment = await ctx.db
    .query("enrollments")
    .withIndex("by_classroom_student", (index) =>
      index.eq("classroomId", release.classroomId).eq("studentId", workspace.studentId),
    )
    .unique();
  if (!enrollment || enrollment.status !== "active") throw new ConvexError("Forbidden");
  const student = await ctx.db.get(workspace.studentId);
  if (!student || student.role !== "student") throw new ConvexError("Student is unavailable");
  return { ...authenticated, release, student };
}

async function requireTeacherWorkspace(
  ctx: Parameters<typeof requireClassroomTeacher>[0],
  workspaceId: Id<"workspaces">,
) {
  const workspace = await ctx.db.get(workspaceId);
  if (!workspace) throw new ConvexError("Workspace not found");
  return { workspace, ...(await requireActiveWorkspaceStudent(ctx, workspace)) };
}

function cleanSessionId(sessionId: string) {
  const cleaned = sessionId.trim();
  if (!cleaned || cleaned.length > 128) throw new ConvexError("Invalid viewer session");
  return cleaned;
}

export const listForTeacher = query({
  args: {},
  handler: async (ctx) => {
    const { organization, user } = await requireRole(ctx, "teacher");
    const assignments = await ctx.db
      .query("classroomTeachers")
      .withIndex("by_teacher", (index) => index.eq("teacherId", user._id))
      .collect();
    const rows = await Promise.all(
      assignments.map(async ({ classroomId }) => {
        const classroom = await ctx.db.get(classroomId);
        if (
          !classroom ||
          classroom.organizationId !== organization._id ||
          classroom.archivedAt !== undefined
        )
          return [];
        const course = await ctx.db.get(classroom.courseId);
        if (!course || course.archivedAt !== undefined) return [];
        const enrollments = await ctx.db
          .query("enrollments")
          .withIndex("by_classroom", (index) => index.eq("classroomId", classroomId))
          .collect();
        const activeStudentIds = new Set(
          enrollments.filter(({ status }) => status === "active").map(({ studentId }) => studentId),
        );
        const releases = await ctx.db
          .query("assignmentReleases")
          .withIndex("by_classroom", (index) => index.eq("classroomId", classroomId))
          .collect();
        return (
          await Promise.all(
            releases.map(async (release) => {
              const assignment = await ctx.db.get(release.assignmentId);
              if (!assignment || assignment.archivedAt !== undefined) return [];
              const workspaces = await ctx.db
                .query("workspaces")
                .withIndex("by_release_student", (index) =>
                  index.eq("assignmentReleaseId", release._id),
                )
                .collect();
              return await Promise.all(
                workspaces
                  .filter(({ studentId }) => activeStudentIds.has(studentId))
                  .map(async (workspace) => {
                    const student = await ctx.db.get(workspace.studentId);
                    if (!student || student.role !== "student") return null;
                    return {
                      workspaceId: workspace._id,
                      assignmentTitle: assignment.title,
                      classroomName: classroom.name,
                      studentDisplayName: student.displayName,
                      studentUsername: student.username,
                      updatedAt: workspace.updatedAt,
                    };
                  }),
              );
            }),
          )
        )
          .flat()
          .filter((row) => row !== null);
      }),
    );
    return rows.flat().sort((left, right) => right.updatedAt - left.updatedAt);
  },
});

export const watch = query({
  args: { workspaceId: v.id("workspaces"), sessionId: v.string() },
  handler: async (ctx, { workspaceId, sessionId: rawSessionId }) => {
    const { release, student, user, workspace } = await requireTeacherWorkspace(ctx, workspaceId);
    const sessionId = cleanSessionId(rawSessionId);
    const presence = await ctx.db
      .query("workspaceViewerPresences")
      .withIndex("by_workspace_session", (index) =>
        index.eq("workspaceId", workspaceId).eq("sessionId", sessionId),
      )
      .unique();
    if (!presence || presence.teacherId !== user._id || presence.expiresAt <= Date.now()) {
      throw new ConvexError("Viewer session ended");
    }
    const [assignment, classroom, version] = await Promise.all([
      ctx.db.get(release.assignmentId),
      ctx.db.get(release.classroomId),
      ctx.db.get(workspace.assignmentVersionId),
    ]);
    if (!assignment || !classroom || !version) {
      throw new ConvexError("Workspace context is unavailable");
    }
    return {
      workspaceId: workspace._id,
      files: workspace.files,
      updatedAt: workspace.updatedAt,
      assignmentTitle: assignment.title,
      classroomName: classroom.name,
      studentDisplayName: student.displayName,
      studentUsername: student.username,
      entrypoint: version.entrypoint,
      runtimeVersion: version.runtimeVersion,
    };
  },
});

export const enter = mutation({
  args: { workspaceId: v.id("workspaces"), sessionId: v.string() },
  handler: async (ctx, { workspaceId, sessionId: rawSessionId }) => {
    const { organization, user } = await requireTeacherWorkspace(ctx, workspaceId);
    const sessionId = cleanSessionId(rawSessionId);
    const existing = await ctx.db
      .query("workspaceViewerPresences")
      .withIndex("by_workspace_session", (index) =>
        index.eq("workspaceId", workspaceId).eq("sessionId", sessionId),
      )
      .unique();
    if (existing && existing.teacherId !== user._id) throw new ConvexError("Forbidden");
    const expiresAt = Date.now() + VIEWER_PRESENCE_TTL_MS;
    const presenceId = existing
      ? existing._id
      : await ctx.db.insert("workspaceViewerPresences", {
          organizationId: organization._id,
          workspaceId,
          teacherId: user._id,
          sessionId,
          expiresAt,
        });
    if (existing) {
      await ctx.db.patch(existing._id, { expiresAt });
    } else {
      await appendAuditEvent(ctx, {
        organizationId: organization._id,
        actor: { kind: "user", userId: user._id },
        action: "workspace.live_view_opened",
        target: { kind: "workspace", id: workspaceId },
      });
    }
    await ctx.scheduler.runAt(expiresAt, internal.liveWorkspaces.expire, {
      presenceId,
      expiresAt,
    });
    return { expiresAt };
  },
});

export const heartbeat = mutation({
  args: { workspaceId: v.id("workspaces"), sessionId: v.string() },
  handler: async (ctx, { workspaceId, sessionId: rawSessionId }) => {
    const { user } = await requireTeacherWorkspace(ctx, workspaceId);
    const sessionId = cleanSessionId(rawSessionId);
    const presence = await ctx.db
      .query("workspaceViewerPresences")
      .withIndex("by_workspace_session", (index) =>
        index.eq("workspaceId", workspaceId).eq("sessionId", sessionId),
      )
      .unique();
    if (!presence || presence.teacherId !== user._id || presence.expiresAt <= Date.now()) {
      throw new ConvexError("Viewer session ended");
    }
    const expiresAt = Date.now() + VIEWER_PRESENCE_TTL_MS;
    await ctx.db.patch(presence._id, { expiresAt });
    await ctx.scheduler.runAt(expiresAt, internal.liveWorkspaces.expire, {
      presenceId: presence._id,
      expiresAt,
    });
    return { expiresAt };
  },
});

export const leave = mutation({
  args: { workspaceId: v.id("workspaces"), sessionId: v.string() },
  handler: async (ctx, { workspaceId, sessionId: rawSessionId }) => {
    const { user } = await requireRole(ctx, "teacher");
    const sessionId = cleanSessionId(rawSessionId);
    const presence = await ctx.db
      .query("workspaceViewerPresences")
      .withIndex("by_workspace_session", (index) =>
        index.eq("workspaceId", workspaceId).eq("sessionId", sessionId),
      )
      .unique();
    if (!presence) return;
    if (presence.teacherId !== user._id) throw new ConvexError("Forbidden");
    await ctx.db.delete(presence._id);
  },
});

export const listViewers = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const { user } = await requireRole(ctx, "student");
    const workspace = await ctx.db.get(workspaceId);
    if (!workspace || workspace.studentId !== user._id) throw new ConvexError("Forbidden");
    const presences = await ctx.db
      .query("workspaceViewerPresences")
      .withIndex("by_workspace", (index) => index.eq("workspaceId", workspaceId))
      .collect();
    const activeTeacherIds = [
      ...new Set(
        presences
          .filter(({ expiresAt }) => expiresAt > Date.now())
          .map(({ teacherId }) => teacherId),
      ),
    ];
    return (
      await Promise.all(
        activeTeacherIds.map(async (teacherId) => {
          const teacher = await ctx.db.get(teacherId);
          return teacher?.role === "teacher"
            ? { teacherId: teacher._id, displayName: teacher.displayName }
            : null;
        }),
      )
    ).filter((teacher) => teacher !== null);
  },
});

export const expire = internalMutation({
  args: { presenceId: v.id("workspaceViewerPresences"), expiresAt: v.number() },
  handler: async (ctx, { presenceId, expiresAt }) => {
    const presence = await ctx.db.get(presenceId);
    if (presence?.expiresAt === expiresAt && expiresAt <= Date.now()) {
      await ctx.db.delete(presenceId);
    }
  },
});
