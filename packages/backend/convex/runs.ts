import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { requireRole } from "./authorization";
import { executionServiceFromEnvironment } from "./execution";
import { requireWritableAssignmentRelease } from "./lifecycleGuards";
import { releasePublicationStatus } from "./releasePolicy";
import { evaluateRun } from "./runEvaluation";

const workspaceFile = v.object({ path: v.string(), content: v.string() });
const executionResult = v.object({
  status: v.union(v.literal("completed"), v.literal("failed"), v.literal("timed_out")),
  stdout: v.string(),
  stderr: v.string(),
  exitCode: v.union(v.number(), v.null()),
  signal: v.union(v.string(), v.null()),
});
const publicTestResult = v.object({
  evaluationTestId: v.id("evaluationTests"),
  name: v.string(),
  passed: v.boolean(),
  stdout: v.string(),
  stderr: v.string(),
  exitCode: v.union(v.number(), v.null()),
});

function validateFiles(workspace: Doc<"workspaces">, files: { path: string; content: string }[]) {
  const expected = workspace.files.map(({ path }) => path);
  const received = files.map(({ path }) => path);
  if (
    expected.length !== received.length ||
    new Set(received).size !== received.length ||
    expected.some((path) => !received.includes(path))
  ) {
    throw new ConvexError("Run files must match the current Workspace file set");
  }
}

export const prepare = internalQuery({
  args: { workspaceId: v.id("workspaces"), files: v.array(workspaceFile) },
  handler: async (ctx, { workspaceId, files }) => {
    const { organization, user } = await requireRole(ctx, "student");
    const workspace = await ctx.db.get(workspaceId);
    if (
      !workspace ||
      workspace.organizationId !== organization._id ||
      workspace.studentId !== user._id
    ) {
      throw new ConvexError("Forbidden");
    }
    validateFiles(workspace, files);
    const [release, version] = await Promise.all([
      ctx.db.get(workspace.assignmentReleaseId),
      ctx.db.get(workspace.assignmentVersionId),
    ]);
    if (
      !release ||
      releasePublicationStatus(release) !== "published" ||
      !version ||
      version.assignmentId !== release.assignmentId
    ) {
      throw new ConvexError("Workspace Assignment Version is unavailable");
    }
    await requireWritableAssignmentRelease(ctx, release._id);
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
      files,
      publicTests: tests.filter((test) => test.visibility === "public"),
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
    files: v.array(workspaceFile),
    execution: executionResult,
    publicTestResults: v.array(publicTestResult),
  },
  handler: async (ctx, input) => {
    const { user } = await requireRole(ctx, "student");
    const workspace = await ctx.db.get(input.workspaceId);
    if (!workspace || workspace.studentId !== user._id || user._id !== input.studentId) {
      throw new ConvexError("Forbidden");
    }
    await requireWritableAssignmentRelease(ctx, input.assignmentReleaseId);
    return await ctx.db.insert("runs", { ...input, completedAt: Date.now() });
  },
});

export const run = action({
  args: { workspaceId: v.id("workspaces"), files: v.array(workspaceFile) },
  handler: async (ctx, input) => {
    const prepared = await ctx.runQuery(internal.runs.prepare, input);
    const result = await evaluateRun(executionServiceFromEnvironment(), prepared);
    const { publicTests: _publicTests, ...record } = prepared;
    const runId = await ctx.runMutation(internal.runs.record, {
      workspaceId: input.workspaceId,
      ...record,
      ...result,
    });
    return { runId, ...result };
  },
});

export const history = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const { user } = await requireRole(ctx, "student");
    const workspace = await ctx.db.get(workspaceId);
    if (!workspace || workspace.studentId !== user._id) throw new ConvexError("Forbidden");
    return await ctx.db
      .query("runs")
      .withIndex("by_workspace", (index) => index.eq("workspaceId", workspaceId))
      .collect();
  },
});
