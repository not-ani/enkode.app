import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { internalQuery, query } from "./_generated/server";
import { requireAuthenticatedUser } from "./authorization";

export async function requireHistoryReader(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
  const authenticated = await requireAuthenticatedUser(ctx);
  const workspace = await ctx.db.get(workspaceId);
  if (!workspace || workspace.organizationId !== authenticated.organization._id) {
    throw new ConvexError("Forbidden");
  }
  if (authenticated.user.role === "student") {
    if (workspace.studentId !== authenticated.user._id) throw new ConvexError("Forbidden");
    return { ...authenticated, workspace };
  }

  const release = await ctx.db.get(workspace.assignmentReleaseId);
  if (!release || release.organizationId !== authenticated.organization._id) {
    throw new ConvexError("Forbidden");
  }
  const assignment = await ctx.db
    .query("classroomTeachers")
    .withIndex("by_classroom_teacher", (index) =>
      index.eq("classroomId", release.classroomId).eq("teacherId", authenticated.user._id),
    )
    .unique();
  if (!assignment) throw new ConvexError("Forbidden");
  return { ...authenticated, workspace };
}

async function historySummary(ctx: QueryCtx, workspace: Doc<"workspaces">) {
  const [student, release] = await Promise.all([
    ctx.db.get(workspace.studentId),
    ctx.db.get(workspace.assignmentReleaseId),
  ]);
  if (!student || !release) throw new ConvexError("Work History context is unavailable");
  const [assignment, classroom] = await Promise.all([
    ctx.db.get(release.assignmentId),
    ctx.db.get(release.classroomId),
  ]);
  if (!assignment || !classroom) throw new ConvexError("Work History context is unavailable");
  return {
    workspaceId: workspace._id,
    assignmentReleaseId: workspace.assignmentReleaseId,
    assignmentTitle: assignment.title,
    classroomName: classroom.name,
    studentName: student.displayName,
    studentUsername: student.username,
    committedThrough: workspace.historyAckSequence ?? 0,
  };
}

export const describe = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const { user, workspace } = await requireHistoryReader(ctx, workspaceId);
    return { ...(await historySummary(ctx, workspace)), viewerRole: user.role };
  },
});

export const listAccessible = query({
  args: {},
  handler: async (ctx) => {
    const { organization, user } = await requireAuthenticatedUser(ctx);
    let workspaces: Doc<"workspaces">[];
    if (user.role === "student") {
      workspaces = await ctx.db
        .query("workspaces")
        .withIndex("by_student", (index) => index.eq("studentId", user._id))
        .collect();
    } else {
      const teachingAssignments = await ctx.db
        .query("classroomTeachers")
        .withIndex("by_teacher", (index) => index.eq("teacherId", user._id))
        .collect();
      const releases = (
        await Promise.all(
          teachingAssignments.map(({ classroomId }) =>
            ctx.db
              .query("assignmentReleases")
              .withIndex("by_classroom", (index) => index.eq("classroomId", classroomId))
              .collect(),
          ),
        )
      ).flat();
      workspaces = (
        await Promise.all(
          releases.map(({ _id }) =>
            ctx.db
              .query("workspaces")
              .withIndex("by_assignment_release", (index) => index.eq("assignmentReleaseId", _id))
              .collect(),
          ),
        )
      ).flat();
    }

    const visible = workspaces.filter(
      (workspace) =>
        workspace.organizationId === organization._id && (workspace.historyAckSequence ?? 0) > 0,
    );
    const summaries = await Promise.all(visible.map((workspace) => historySummary(ctx, workspace)));
    return summaries.sort((left, right) =>
      left.classroomName === right.classroomName
        ? left.assignmentTitle.localeCompare(right.assignmentTitle)
        : left.classroomName.localeCompare(right.classroomName),
    );
  },
});

export const readPlan = internalQuery({
  args: { workspaceId: v.id("workspaces"), afterSequence: v.number() },
  handler: async (ctx, { workspaceId, afterSequence }) => {
    await requireHistoryReader(ctx, workspaceId);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new ConvexError("Invalid Work History cursor");
    }
    const chunk = await ctx.db
      .query("workHistoryChunks")
      .withIndex("by_workspace_sequence", (index) =>
        index.eq("workspaceId", workspaceId).eq("startSequence", afterSequence + 1),
      )
      .unique();
    if (!chunk) return undefined;
    const previous =
      afterSequence === 0
        ? undefined
        : await ctx.db
            .query("workHistoryChunks")
            .withIndex("by_workspace_sequence", (index) =>
              index.eq("workspaceId", workspaceId).lt("startSequence", chunk.startSequence),
            )
            .order("desc")
            .first();
    if (
      afterSequence > 0 &&
      (previous?.endSequence !== afterSequence ||
        !previous.snapshotObjectKey ||
        !previous.snapshotHash ||
        previous.snapshotByteLength === undefined)
    ) {
      throw new ConvexError("Work History replay baseline is unavailable");
    }
    const next = await ctx.db
      .query("workHistoryChunks")
      .withIndex("by_workspace_sequence", (index) =>
        index.eq("workspaceId", workspaceId).eq("startSequence", chunk.endSequence + 1),
      )
      .unique();
    return {
      workspaceId,
      chunk,
      baseline: previous
        ? {
            manifest: previous,
            objectKey: previous.snapshotObjectKey!,
            contentHash: previous.snapshotHash!,
            byteLength: previous.snapshotByteLength!,
          }
        : undefined,
      nextSequence: next?.startSequence,
    };
  },
});
