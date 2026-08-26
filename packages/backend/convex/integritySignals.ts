import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireClassroomTeacher, requireRole } from "./authorization";
import { transitionIntegritySignal } from "./integritySignalPolicy";
import { requireWritableAssignmentRelease } from "./lifecycleGuards";

export const eventCandidate = v.object({
  type: v.union(v.literal("large_paste"), v.literal("unattributed_bulk_change")),
  evidenceKey: v.string(),
  eventSequence: v.number(),
  path: v.string(),
  insertedCharacters: v.number(),
  deletedCharacters: v.number(),
  resultingFileCharacters: v.number(),
  contribution: v.number(),
});

const matchedSpan = v.object({
  path: v.string(),
  start: v.number(),
  end: v.number(),
  relatedPath: v.string(),
  relatedStart: v.number(),
  relatedEnd: v.number(),
  text: v.string(),
});

async function teachesWorkspace(
  ctx: QueryCtx | MutationCtx,
  teacherId: Id<"users">,
  workspaceId: Id<"workspaces">,
) {
  const workspace = await ctx.db.get(workspaceId);
  if (!workspace) return false;
  const release = await ctx.db.get(workspace.assignmentReleaseId);
  if (!release) return false;
  return Boolean(
    await ctx.db
      .query("classroomTeachers")
      .withIndex("by_classroom_teacher", (index) =>
        index.eq("classroomId", release.classroomId).eq("teacherId", teacherId),
      )
      .unique(),
  );
}

async function requireSignalTeacher(ctx: QueryCtx | MutationCtx, signalId: Id<"integritySignals">) {
  const signal = await ctx.db.get(signalId);
  if (!signal) throw new ConvexError("Integrity Signal not found");
  const authenticated = await requireRole(ctx, "teacher");
  if (signal.organizationId !== authenticated.organization._id) throw new ConvexError("Forbidden");
  const workspace = await ctx.db.get(signal.workspaceId);
  if (!workspace) throw new ConvexError("Integrity Signal evidence is unavailable");
  const responsible =
    (await teachesWorkspace(ctx, authenticated.user._id, signal.workspaceId)) ||
    (signal.relatedWorkspaceId
      ? await teachesWorkspace(ctx, authenticated.user._id, signal.relatedWorkspaceId)
      : false);
  if (!responsible) throw new ConvexError("Forbidden");
  return { ...authenticated, signal, workspace };
}

export const createEventSignals = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    studentId: v.id("users"),
    candidates: v.array(eventCandidate),
  },
  handler: async (ctx, input) => {
    for (const candidate of input.candidates) {
      const existing = await ctx.db
        .query("integritySignals")
        .withIndex("by_evidence_key", (index) => index.eq("evidenceKey", candidate.evidenceKey))
        .unique();
      if (existing) continue;
      await ctx.db.insert("integritySignals", {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        studentId: input.studentId,
        state: "open",
        createdAt: Date.now(),
        ...candidate,
      });
    }
  },
});

export const recordGap = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    studentId: v.id("users"),
    evidenceKey: v.string(),
    sequenceStart: v.number(),
    sequenceEnd: v.number(),
    gapReason: v.union(
      v.literal("missing segment"),
      v.literal("reordered segment"),
      v.literal("unverifiable segment"),
    ),
  },
  handler: async (ctx, input) => {
    const existing = await ctx.db
      .query("integritySignals")
      .withIndex("by_evidence_key", (index) => index.eq("evidenceKey", input.evidenceKey))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("integritySignals", {
      ...input,
      type: "work_history_gap",
      state: "open",
      createdAt: Date.now(),
    });
  },
});

export const recordSimilarity = internalMutation({
  args: {
    submissionId: v.id("submissions"),
    relatedSubmissionId: v.id("submissions"),
    matchedSpans: v.array(matchedSpan),
  },
  handler: async (ctx, input) => {
    if (input.matchedSpans.length === 0) return;
    const [submission, related] = await Promise.all([
      ctx.db.get(input.submissionId),
      ctx.db.get(input.relatedSubmissionId),
    ]);
    if (
      !submission ||
      !related ||
      submission.organizationId !== related.organizationId ||
      submission.assignmentVersionId !== related.assignmentVersionId ||
      submission.studentId === related.studentId
    ) {
      throw new ConvexError("Similarity comparison scope is invalid");
    }
    const [snapshot, relatedSnapshot] = await Promise.all([
      ctx.db.get(submission.snapshotId),
      ctx.db.get(related.snapshotId),
    ]);
    if (
      !snapshot ||
      !relatedSnapshot ||
      snapshot.organizationId !== submission.organizationId ||
      relatedSnapshot.organizationId !== submission.organizationId ||
      snapshot.assignmentVersionId !== submission.assignmentVersionId ||
      relatedSnapshot.assignmentVersionId !== submission.assignmentVersionId
    ) {
      throw new ConvexError("Similarity comparison provenance is unavailable");
    }
    const pair = [submission._id, related._id].sort();
    const evidenceKey = `similarity:${pair[0]}:${pair[1]}`;
    const existing = await ctx.db
      .query("integritySignals")
      .withIndex("by_evidence_key", (index) => index.eq("evidenceKey", evidenceKey))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("integritySignals", {
      organizationId: submission.organizationId,
      workspaceId: submission.workspaceId,
      studentId: submission.studentId,
      relatedWorkspaceId: related.workspaceId,
      relatedStudentId: related.studentId,
      submissionId: submission._id,
      relatedSubmissionId: related._id,
      submissionHistorySequence: snapshot.historySequence,
      relatedSubmissionHistorySequence: relatedSnapshot.historySequence,
      type: "similarity",
      state: "open",
      evidenceKey,
      matchedSpans: input.matchedSpans,
      createdAt: Date.now(),
    });
  },
});

export const listForWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const authenticated = await requireRole(ctx, "teacher");
    const workspace = await ctx.db.get(workspaceId);
    if (!workspace || workspace.organizationId !== authenticated.organization._id) {
      throw new ConvexError("Forbidden");
    }
    const release = await ctx.db.get(workspace.assignmentReleaseId);
    if (!release || release.organizationId !== authenticated.organization._id) {
      throw new ConvexError("Forbidden");
    }
    await requireClassroomTeacher(ctx, release.classroomId);
    const [owned, related] = await Promise.all([
      ctx.db
        .query("integritySignals")
        .withIndex("by_workspace", (index) => index.eq("workspaceId", workspaceId))
        .order("desc")
        .collect(),
      ctx.db
        .query("integritySignals")
        .withIndex("by_related_workspace", (index) => index.eq("relatedWorkspaceId", workspaceId))
        .order("desc")
        .collect(),
    ]);
    return [...owned, ...related].sort((left, right) => right.createdAt - left.createdAt);
  },
});

export const review = mutation({
  args: {
    signalId: v.id("integritySignals"),
    state: v.union(v.literal("reviewed"), v.literal("dismissed")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { signalId, state, note }) => {
    const { signal, user, workspace } = await requireSignalTeacher(ctx, signalId);
    await requireWritableAssignmentRelease(ctx, workspace.assignmentReleaseId);
    let next;
    try {
      next = transitionIntegritySignal(signal.state, state);
    } catch (error) {
      throw new ConvexError(error instanceof Error ? error.message : "Invalid review state");
    }
    const teacherNote = note?.trim();
    if (teacherNote && teacherNote.length > 2_000) {
      throw new ConvexError("Teacher note must be 2,000 characters or fewer");
    }
    await ctx.db.patch(signalId, {
      state: next,
      teacherNote: teacherNote || undefined,
      reviewedBy: user._id,
      reviewedAt: Date.now(),
    });
  },
});

export const evidencePlan = internalQuery({
  args: { signalId: v.id("integritySignals") },
  handler: async (ctx, { signalId }) => {
    const { signal } = await requireSignalTeacher(ctx, signalId);
    if (signal.type === "similarity") {
      const [student, relatedStudent] = await Promise.all([
        ctx.db.get(signal.studentId),
        signal.relatedStudentId ? ctx.db.get(signal.relatedStudentId) : undefined,
      ]);
      if (!student || !relatedStudent)
        throw new ConvexError("Integrity Signal evidence is unavailable");
      return {
        signal,
        similarity: {
          students: [
            { id: student._id, displayName: student.displayName, username: student.username },
            {
              id: relatedStudent._id,
              displayName: relatedStudent.displayName,
              username: relatedStudent.username,
            },
          ],
          matchedSpans: signal.matchedSpans ?? [],
          provenance: [
            {
              submissionId: signal.submissionId,
              workspaceId: signal.workspaceId,
              historySequence: signal.submissionHistorySequence,
            },
            {
              submissionId: signal.relatedSubmissionId,
              workspaceId: signal.relatedWorkspaceId,
              historySequence: signal.relatedSubmissionHistorySequence,
            },
          ],
        },
      };
    }
    if (signal.eventSequence === undefined) return { signal };
    const chunk = await ctx.db
      .query("workHistoryChunks")
      .withIndex("by_workspace_sequence", (index) =>
        index.eq("workspaceId", signal.workspaceId).lte("startSequence", signal.eventSequence!),
      )
      .order("desc")
      .first();
    if (!chunk || chunk.endSequence < signal.eventSequence) {
      throw new ConvexError("Integrity Signal event is unavailable");
    }
    return { signal, chunk };
  },
});
