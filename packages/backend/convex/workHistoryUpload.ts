"use node";

import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { objectStorageFromEnvironment } from "./objectStorage";
import { objectKeys, validateChunkPayload } from "./workHistoryProtocol";

export const acceptChunk = action({
  args: {
    workspaceId: v.id("workspaces"),
    startSequence: v.number(),
    endSequence: v.number(),
    eventCount: v.number(),
    contentHash: v.string(),
    byteLength: v.number(),
    bytes: v.bytes(),
    snapshotHash: v.optional(v.string()),
    snapshotByteLength: v.optional(v.number()),
    snapshotBytes: v.optional(v.bytes()),
  },
  handler: async (ctx, input): Promise<{ acknowledgedThrough: number }> => {
    const owner = await ctx.runQuery(internal.workHistory.authorizeUpload, {
      workspaceId: input.workspaceId,
    });
    const bytes = new Uint8Array(input.bytes);
    const snapshotBytes = input.snapshotBytes ? new Uint8Array(input.snapshotBytes) : undefined;
    try {
      validateChunkPayload(input, bytes, snapshotBytes);
    } catch (error) {
      throw new ConvexError(error instanceof Error ? error.message : "Invalid Work History chunk");
    }
    const keys = objectKeys(owner.organizationId, input);
    const storage = objectStorageFromEnvironment();
    await storage.putImmutable({
      key: keys.chunk,
      bytes,
      contentType: "application/gzip",
      sha256: input.contentHash,
    });
    if (snapshotBytes && input.snapshotHash && keys.snapshot) {
      await storage.putImmutable({
        key: keys.snapshot,
        bytes: snapshotBytes,
        contentType: "application/gzip",
        sha256: input.snapshotHash,
      });
    }
    return await ctx.runMutation(internal.workHistory.commitChunk, {
      workspaceId: input.workspaceId,
      organizationId: owner.organizationId,
      studentId: owner.studentId,
      startSequence: input.startSequence,
      endSequence: input.endSequence,
      eventCount: input.eventCount,
      contentHash: input.contentHash,
      objectKey: keys.chunk,
      byteLength: input.byteLength,
      snapshotHash: input.snapshotHash,
      snapshotObjectKey: keys.snapshot,
      snapshotByteLength: input.snapshotByteLength,
    });
  },
});
