import { ConvexError, v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireClassroomTeacher, requireRole } from "./authorization";
import { transitionIntegritySignal } from "./integritySignalPolicy";

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

async function requireSignalTeacher(ctx: QueryCtx | MutationCtx, signalId: Id<"integritySignals">) {
  const signal = await ctx.db.get(signalId);
  if (!signal) throw new ConvexError("Integrity Signal not found");
  const workspace = await ctx.db.get(signal.workspaceId);
  if (!workspace) throw new ConvexError("Integrity Signal evidence is unavailable");
  const release = await ctx.db.get(workspace.assignmentReleaseId);
  if (!release) throw new ConvexError("Integrity Signal evidence is unavailable");
  const authenticated = await requireClassroomTeacher(ctx, release.classroomId);
  if (signal.organizationId !== authenticated.organization._id) throw new ConvexError("Forbidden");
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
    return await ctx.db
      .query("integritySignals")
      .withIndex("by_workspace", (index) => index.eq("workspaceId", workspaceId))
      .order("desc")
      .collect();
  },
});

export const review = mutation({
  args: {
    signalId: v.id("integritySignals"),
    state: v.union(v.literal("reviewed"), v.literal("dismissed")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { signalId, state, note }) => {
    const { signal, user } = await requireSignalTeacher(ctx, signalId);
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
