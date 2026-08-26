import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { requireClassroomTeacher, requireRole } from "./authorization";
import { releasePublicationStatus } from "./releasePolicy";

const workspaceFile = v.object({ path: v.string(), content: v.string() });
const executionResult = v.object({
  status: v.union(v.literal("completed"), v.literal("failed"), v.literal("timed_out")),
  stdout: v.string(),
  stderr: v.string(),
  exitCode: v.union(v.number(), v.null()),
  signal: v.union(v.string(), v.null()),
});
const testResult = v.object({
  evaluationTestId: v.id("evaluationTests"),
  name: v.string(),
  visibility: v.union(v.literal("public"), v.literal("hidden")),
  weight: v.number(),
  passed: v.boolean(),
  guidance: v.optional(v.string()),
  stdout: v.string(),
  stderr: v.string(),
  exitCode: v.union(v.number(), v.null()),
});

function sameFiles(left: { path: string; content: string }[], right: typeof left) {
  return (
    left.length === right.length &&
    left.every(
      (file, index) => file.path === right[index]?.path && file.content === right[index].content,
    )
  );
}

function studentVisible(submission: Doc<"submissions">) {
  return {
    ...submission,
    testResults: submission.testResults.map((result) =>
      result.visibility === "public"
        ? result
        : {
            visibility: result.visibility,
            weight: result.weight,
            passed: result.passed,
            ...(result.guidance === undefined ? {} : { guidance: result.guidance }),
          },
    ),
  };
}

export const prepare = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    files: v.array(workspaceFile),
    requiredHistorySequence: v.number(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, input) => {
    const { organization, user } = await requireRole(ctx, "student");
    const workspace = await ctx.db.get(input.workspaceId);
    if (
      !workspace ||
      workspace.organizationId !== organization._id ||
      workspace.studentId !== user._id
    ) {
      throw new ConvexError("Forbidden");
    }
    const existing = await ctx.db
      .query("submissions")
      .withIndex("by_workspace_idempotency", (index) =>
        index.eq("workspaceId", workspace._id).eq("idempotencyKey", input.idempotencyKey),
      )
      .unique();
    if (existing) return { existing: studentVisible(existing) };
    if (!input.idempotencyKey.trim()) throw new ConvexError("Submission retry key is required");
    if (!Number.isSafeInteger(input.requiredHistorySequence) || input.requiredHistorySequence < 1) {
      throw new ConvexError("Submission requires finalized Work History");
    }
    if ((workspace.historyAckSequence ?? 0) < input.requiredHistorySequence) {
      throw new ConvexError("Required Work History is not durably acknowledged");
    }
    const historyChunk = await ctx.db
      .query("workHistoryChunks")
      .withIndex("by_workspace_sequence", (index) => index.eq("workspaceId", workspace._id))
      .filter((filter) => filter.eq(filter.field("endSequence"), input.requiredHistorySequence))
      .unique();
    if (!historyChunk?.snapshotHash || !historyChunk.snapshotObjectKey) {
      throw new ConvexError("Finalized Work History snapshot is unavailable");
    }
    if (!sameFiles(workspace.files, input.files)) {
      throw new ConvexError("Save the current Workspace before submitting");
    }
    const [release, version] = await Promise.all([
      ctx.db.get(workspace.assignmentReleaseId),
      ctx.db.get(workspace.assignmentVersionId),
    ]);
    if (
      !release ||
      releasePublicationStatus(release) !== "published" ||
      !version ||
      release.assignmentVersionId !== version._id
    ) {
      throw new ConvexError("Workspace Assignment Version is unavailable");
    }
    const enrollment = await ctx.db
      .query("enrollments")
      .withIndex("by_classroom_student", (index) =>
        index.eq("classroomId", release.classroomId).eq("studentId", user._id),
      )
      .unique();
    if (!enrollment || enrollment.status !== "active") throw new ConvexError("Forbidden");
    const tests = await ctx.db
      .query("evaluationTests")
      .withIndex("by_version", (index) => index.eq("assignmentVersionId", version._id))
      .collect();
    return {
      organizationId: organization._id,
      studentId: user._id,
      assignmentReleaseId: release._id,
      assignmentVersionId: version._id,
      runtimeVersion: version.runtimeVersion,
      entrypoint: version.entrypoint,
      files: input.files,
      requiredHistorySequence: input.requiredHistorySequence,
      idempotencyKey: input.idempotencyKey,
      tests,
    };
  },
});

export const record = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    organizationId: v.id("organizations"),
    studentId: v.id("users"),
    assignmentReleaseId: v.id("assignmentReleases"),
    assignmentVersionId: v.id("assignmentVersions"),
    runtimeVersion: v.string(),
    entrypoint: v.string(),
    historySequence: v.number(),
    idempotencyKey: v.string(),
    snapshot: v.object({
      objectKey: v.string(),
      contentHash: v.string(),
      byteLength: v.number(),
      files: v.array(
        v.object({ path: v.string(), contentHash: v.string(), byteLength: v.number() }),
      ),
    }),
    execution: executionResult,
    testResults: v.array(testResult),
    proposedPoints: v.number(),
  },
  handler: async (ctx, input) => {
    const { user } = await requireRole(ctx, "student");
    const workspace = await ctx.db.get(input.workspaceId);
    if (!workspace || workspace.studentId !== user._id || input.studentId !== user._id) {
      throw new ConvexError("Forbidden");
    }
    const existing = await ctx.db
      .query("submissions")
      .withIndex("by_workspace_idempotency", (index) =>
        index.eq("workspaceId", workspace._id).eq("idempotencyKey", input.idempotencyKey),
      )
      .unique();
    if (existing) return studentVisible(existing);
    const attempts = await ctx.db
      .query("submissions")
      .withIndex("by_workspace_attempt", (index) => index.eq("workspaceId", workspace._id))
      .collect();
    const now = Date.now();
    const snapshotId = await ctx.db.insert("submissionSnapshots", {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      assignmentVersionId: input.assignmentVersionId,
      historySequence: input.historySequence,
      ...input.snapshot,
      createdAt: now,
    });
    const submissionId = await ctx.db.insert("submissions", {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      assignmentReleaseId: input.assignmentReleaseId,
      assignmentVersionId: input.assignmentVersionId,
      studentId: input.studentId,
      snapshotId,
      idempotencyKey: input.idempotencyKey,
      attemptNumber: attempts.length + 1,
      runtimeVersion: input.runtimeVersion,
      entrypoint: input.entrypoint,
      execution: input.execution,
      testResults: input.testResults,
      proposedPoints: input.proposedPoints,
      submittedAt: now,
    });
    return studentVisible((await ctx.db.get(submissionId))!);
  },
});

export const mine = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const { user } = await requireRole(ctx, "student");
    const workspace = await ctx.db.get(workspaceId);
    if (!workspace || workspace.studentId !== user._id) throw new ConvexError("Forbidden");
    const submissions = await ctx.db
      .query("submissions")
      .withIndex("by_workspace_attempt", (index) => index.eq("workspaceId", workspaceId))
      .collect();
    return submissions.reverse().map((submission, index) => ({
      ...studentVisible(submission),
      current: index === 0,
    }));
  },
});

export const forTeacher = query({
  args: { assignmentReleaseId: v.id("assignmentReleases"), studentId: v.id("users") },
  handler: async (ctx, { assignmentReleaseId, studentId }) => {
    const release = await ctx.db.get(assignmentReleaseId);
    if (!release) throw new ConvexError("Assignment Release not found");
    await requireClassroomTeacher(ctx, release.classroomId);
    const submissions = await ctx.db
      .query("submissions")
      .withIndex("by_release_student_attempt", (index) =>
        index.eq("assignmentReleaseId", assignmentReleaseId).eq("studentId", studentId),
      )
      .collect();
    return submissions.reverse().map((submission, index) => ({
      ...submission,
      current: index === 0,
    }));
  },
});
