import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation } from "./_generated/server";
import { requireRole } from "./authorization";
import { requireWritableAssignmentRelease } from "./lifecycleGuards";
import { releasePublicationStatus } from "./releasePolicy";

const workspaceFile = v.object({ path: v.string(), content: v.string() });

async function requireStudentRelease(
  ctx: MutationCtx,
  assignmentReleaseId: Id<"assignmentReleases">,
) {
  const { organization, user } = await requireRole(ctx, "student");
  const release = await ctx.db.get(assignmentReleaseId);
  if (
    !release ||
    release.organizationId !== organization._id ||
    releasePublicationStatus(release) !== "published"
  ) {
    throw new ConvexError("Forbidden");
  }
  await requireWritableAssignmentRelease(ctx, assignmentReleaseId);
  const enrollment = await ctx.db
    .query("enrollments")
    .withIndex("by_classroom_student", (index) =>
      index.eq("classroomId", release.classroomId).eq("studentId", user._id),
    )
    .unique();
  if (!enrollment || enrollment.status !== "active") throw new ConvexError("Forbidden");
  return { organization, release, user };
}

function ensureOwner(workspace: Doc<"workspaces"> | null, studentId: Id<"users">) {
  if (!workspace || workspace.studentId !== studentId) throw new ConvexError("Forbidden");
  return workspace;
}

export const open = mutation({
  args: { assignmentReleaseId: v.id("assignmentReleases") },
  handler: async (ctx, { assignmentReleaseId }) => {
    const { organization, release, user } = await requireStudentRelease(ctx, assignmentReleaseId);
    const existing = await ctx.db
      .query("workspaces")
      .withIndex("by_release_student", (index) =>
        index.eq("assignmentReleaseId", assignmentReleaseId).eq("studentId", user._id),
      )
      .unique();
    if (existing) return existing;

    const starterFiles = await ctx.db
      .query("assignmentStarterFiles")
      .withIndex("by_version", (index) =>
        index.eq("assignmentVersionId", release.assignmentVersionId),
      )
      .collect();
    const now = Date.now();
    const workspaceId = await ctx.db.insert("workspaces", {
      organizationId: organization._id,
      assignmentReleaseId,
      assignmentVersionId: release.assignmentVersionId,
      studentId: user._id,
      files: starterFiles.map(({ path, content }) => ({ path, content })),
      historyAckSequence: 0,
      createdAt: now,
      updatedAt: now,
    });
    const workspace = await ctx.db.get(workspaceId);
    if (!workspace) throw new ConvexError("Workspace could not be created");
    return workspace;
  },
});

export const save = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    files: v.array(workspaceFile),
  },
  handler: async (ctx, { workspaceId, files }) => {
    const { user } = await requireRole(ctx, "student");
    const workspace = ensureOwner(await ctx.db.get(workspaceId), user._id);
    await requireStudentRelease(ctx, workspace.assignmentReleaseId);

    const expectedPaths = workspace.files.map(({ path }) => path);
    const receivedPaths = files.map(({ path }) => path);
    if (
      expectedPaths.length !== receivedPaths.length ||
      new Set(receivedPaths).size !== receivedPaths.length ||
      expectedPaths.some((path, index) => path !== receivedPaths[index])
    ) {
      throw new ConvexError("Workspace files must preserve the released file set and order");
    }

    const updatedAt = Date.now();
    await ctx.db.patch(workspaceId, { files, updatedAt });
    return { updatedAt };
  },
});
