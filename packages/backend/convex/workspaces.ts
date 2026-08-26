import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation } from "./_generated/server";
import { applyStarterMerge, mergePlan, starterFilesFor } from "./assignmentVersionMerge";
import { appendAuditEvent } from "./audit";
import { requireRole } from "./authorization";
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

async function workspaceDetails(ctx: MutationCtx, workspace: Doc<"workspaces">) {
  const version = await ctx.db.get(workspace.assignmentVersionId);
  if (!version) throw new ConvexError("Workspace Assignment Version is unavailable");
  const pending = await ctx.db
    .query("workspaceVersionMerges")
    .withIndex("by_workspace_status", (index) =>
      index.eq("workspaceId", workspace._id).eq("status", "pending"),
    )
    .unique();
  let versionMerge;
  if (pending) {
    const [fromVersion, toVersion] = await Promise.all([
      ctx.db.get(pending.fromAssignmentVersionId),
      ctx.db.get(pending.toAssignmentVersionId),
    ]);
    if (!fromVersion || !toVersion)
      throw new ConvexError("Assignment Version merge is unavailable");
    const plan = await mergePlan(ctx, fromVersion, toVersion);
    const current = new Map(workspace.files.map((file) => [file.path, file.content]));
    versionMerge = {
      mergeId: pending._id,
      fromVersion: plan.fromVersion.version,
      toVersion: plan.toVersion.version,
      fromAssignmentVersionId: fromVersion._id,
      toAssignmentVersionId: toVersion._id,
      changedStarterFiles: plan.changedStarterFiles.map((file) => ({
        ...file,
        currentContent: current.get(file.path),
      })),
    };
  }
  return {
    ...workspace,
    version: version.version,
    runtimeVersion: version.runtimeVersion,
    entrypoint: version.entrypoint,
    versionMerge,
  };
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
    if (existing) return await workspaceDetails(ctx, existing);

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
    return await workspaceDetails(ctx, workspace);
  },
});

export const completeVersionMerge = mutation({
  args: {
    mergeId: v.id("workspaceVersionMerges"),
    decisions: v.array(
      v.object({
        path: v.string(),
        choice: v.union(v.literal("keep_current"), v.literal("accept_new")),
      }),
    ),
    acknowledged: v.boolean(),
    requiredHistorySequence: v.number(),
  },
  handler: async (ctx, { mergeId, decisions, acknowledged, requiredHistorySequence }) => {
    const { user } = await requireRole(ctx, "student");
    const merge = await ctx.db.get(mergeId);
    if (!merge || merge.status !== "pending") throw new ConvexError("Version merge is unavailable");
    const workspace = ensureOwner(await ctx.db.get(merge.workspaceId), user._id);
    await requireStudentRelease(ctx, workspace.assignmentReleaseId);
    if (!acknowledged) throw new ConvexError("Acknowledge the starter-file decisions first");
    if (
      !Number.isSafeInteger(requiredHistorySequence) ||
      requiredHistorySequence < 1 ||
      (workspace.historyAckSequence ?? 0) < requiredHistorySequence
    ) {
      throw new ConvexError("Assignment Version merge requires acknowledged Work History");
    }
    if (workspace.assignmentVersionId !== merge.fromAssignmentVersionId) {
      throw new ConvexError("Workspace changed after this merge was prepared");
    }
    const mergeHistory = await ctx.db
      .query("workspaceAssignmentVersionMergeEvents")
      .withIndex("by_workspace_sequence", (index) =>
        index.eq("workspaceId", workspace._id).lte("sequence", requiredHistorySequence),
      )
      .order("desc")
      .first();
    const acceptedPaths = decisions
      .filter(({ choice }) => choice === "accept_new")
      .map(({ path }) => path)
      .sort();
    if (
      !mergeHistory ||
      mergeHistory.fromAssignmentVersionId !== String(merge.fromAssignmentVersionId) ||
      mergeHistory.toAssignmentVersionId !== String(merge.toAssignmentVersionId) ||
      [...mergeHistory.acceptedPaths].sort().join("\0") !== acceptedPaths.join("\0")
    ) {
      throw new ConvexError(
        "Acknowledged Work History does not contain this Assignment Version merge",
      );
    }
    const [fromVersion, toVersion, fromFiles, toFiles] = await Promise.all([
      ctx.db.get(merge.fromAssignmentVersionId),
      ctx.db.get(merge.toAssignmentVersionId),
      starterFilesFor(ctx, merge.fromAssignmentVersionId),
      starterFilesFor(ctx, merge.toAssignmentVersionId),
    ]);
    if (!fromVersion || !toVersion)
      throw new ConvexError("Assignment Version merge is unavailable");
    let files;
    try {
      files = applyStarterMerge(workspace.files, fromFiles, toFiles, decisions);
    } catch (error) {
      throw new ConvexError(error instanceof Error ? error.message : "Invalid merge decisions");
    }
    if (files.length === 0) throw new ConvexError("A Workspace needs at least one file");
    const now = Date.now();
    await ctx.db.patch(workspace._id, {
      assignmentVersionId: toVersion._id,
      files,
      updatedAt: now,
    });
    await ctx.db.patch(merge._id, {
      status: "completed",
      completedAt: now,
      decisions,
      historySequence: requiredHistorySequence,
    });
    await appendAuditEvent(ctx, {
      organizationId: workspace.organizationId,
      actor: { kind: "user", userId: user._id },
      action: "workspace.assignment_version_merged",
      target: { kind: "workspace", id: workspace._id },
    });
    return await workspaceDetails(ctx, (await ctx.db.get(workspace._id))!);
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
