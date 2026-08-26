import { ConvexError, v } from "convex/values";

import { internalMutation, internalQuery, query } from "./_generated/server";
import { requireRole } from "./authorization";
import { eventCandidate } from "./integritySignals";

export const authorizeUpload = internalQuery({
  args: { workspaceId: v.id("workspaces"), startSequence: v.number() },
  handler: async (ctx, { workspaceId, startSequence }) => {
    const { organization, user } = await requireRole(ctx, "student");
    const workspace = await ctx.db.get(workspaceId);
    if (
      !workspace ||
      workspace.organizationId !== organization._id ||
      workspace.studentId !== user._id
    ) {
      throw new ConvexError("Forbidden");
    }
    const previous = await ctx.db
      .query("workHistoryChunks")
      .withIndex("by_workspace_sequence", (index) =>
        index.eq("workspaceId", workspaceId).lt("startSequence", startSequence),
      )
      .order("desc")
      .first();
    const exact = await ctx.db
      .query("workHistoryChunks")
      .withIndex("by_workspace_sequence", (index) =>
        index.eq("workspaceId", workspaceId).eq("startSequence", startSequence),
      )
      .unique();
    return {
      organizationId: organization._id,
      studentId: user._id,
      acknowledgedThrough: workspace.historyAckSequence ?? 0,
      exact,
      previous:
        previous?.snapshotHash &&
        previous.snapshotObjectKey &&
        previous.snapshotByteLength !== undefined
          ? {
              manifest: previous,
              objectKey: previous.snapshotObjectKey,
              contentHash: previous.snapshotHash,
              byteLength: previous.snapshotByteLength,
            }
          : undefined,
    };
  },
});

export const commitChunk = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    organizationId: v.id("organizations"),
    studentId: v.id("users"),
    startSequence: v.number(),
    endSequence: v.number(),
    eventCount: v.number(),
    contentHash: v.string(),
    objectKey: v.string(),
    byteLength: v.number(),
    snapshotHash: v.optional(v.string()),
    snapshotObjectKey: v.optional(v.string()),
    snapshotByteLength: v.optional(v.number()),
    signalCandidates: v.optional(v.array(eventCandidate)),
  },
  handler: async (ctx, manifest) => {
    const workspace = await ctx.db.get(manifest.workspaceId);
    if (
      !workspace ||
      workspace.organizationId !== manifest.organizationId ||
      workspace.studentId !== manifest.studentId
    ) {
      throw new ConvexError("Work History ownership changed before commit");
    }

    const exactStart = await ctx.db
      .query("workHistoryChunks")
      .withIndex("by_workspace_sequence", (index) =>
        index.eq("workspaceId", workspace._id).eq("startSequence", manifest.startSequence),
      )
      .first();
    if (exactStart) {
      if (
        exactStart.endSequence !== manifest.endSequence ||
        exactStart.contentHash !== manifest.contentHash ||
        exactStart.eventCount !== manifest.eventCount ||
        exactStart.byteLength !== manifest.byteLength ||
        exactStart.objectKey !== manifest.objectKey ||
        exactStart.snapshotHash !== manifest.snapshotHash ||
        exactStart.snapshotObjectKey !== manifest.snapshotObjectKey ||
        exactStart.snapshotByteLength !== manifest.snapshotByteLength
      ) {
        throw new ConvexError("Work History range overlaps different content");
      }
      return { acknowledgedThrough: workspace.historyAckSequence ?? 0 };
    }

    const acknowledgedThrough = workspace.historyAckSequence ?? 0;
    if (manifest.startSequence !== acknowledgedThrough + 1) {
      throw new ConvexError(
        manifest.startSequence > acknowledgedThrough + 1
          ? `Work History sequence gap; expected ${acknowledgedThrough + 1}`
          : "Work History range overlaps or is behind committed history",
      );
    }
    if (
      manifest.endSequence < manifest.startSequence ||
      manifest.eventCount !== manifest.endSequence - manifest.startSequence + 1
    ) {
      throw new ConvexError("Work History range does not match its event count");
    }

    await ctx.db.insert("workHistoryChunks", {
      workspaceId: manifest.workspaceId,
      organizationId: manifest.organizationId,
      studentId: manifest.studentId,
      startSequence: manifest.startSequence,
      endSequence: manifest.endSequence,
      eventCount: manifest.eventCount,
      contentHash: manifest.contentHash,
      objectKey: manifest.objectKey,
      byteLength: manifest.byteLength,
      snapshotHash: manifest.snapshotHash,
      snapshotObjectKey: manifest.snapshotObjectKey,
      snapshotByteLength: manifest.snapshotByteLength,
      encoding: "gzip-json-v1",
      committedAt: Date.now(),
    });
    for (const candidate of manifest.signalCandidates ?? []) {
      await ctx.db.insert("integritySignals", {
        organizationId: manifest.organizationId,
        workspaceId: manifest.workspaceId,
        studentId: manifest.studentId,
        state: "open",
        createdAt: Date.now(),
        ...candidate,
      });
    }
    await ctx.db.patch(workspace._id, { historyAckSequence: manifest.endSequence });
    return { acknowledgedThrough: manifest.endSequence };
  },
});

export const acknowledgement = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const { user } = await requireRole(ctx, "student");
    const workspace = await ctx.db.get(workspaceId);
    if (!workspace || workspace.studentId !== user._id) throw new ConvexError("Forbidden");
    return { acknowledgedThrough: workspace.historyAckSequence ?? 0 };
  },
});
