"use node";

import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { objectStorageFromEnvironment } from "./objectStorage";
import { eventSignalCandidates } from "./integritySignalPolicy";
import { decodeSnapshotPayload, objectKeys, validateChunkPayload } from "./workHistoryProtocol";
import type { ReplayFile } from "./workHistoryReplayModel";
import { reconstructReplayFrames, sameReplayFiles } from "./workHistoryReplayModel";

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
      startSequence: input.startSequence,
    });
    const expectedSequence = owner.acknowledgedThrough + 1;
    if (input.startSequence > expectedSequence) {
      await ctx.runMutation(internal.integritySignals.recordGap, {
        organizationId: owner.organizationId,
        workspaceId: input.workspaceId,
        studentId: owner.studentId,
        evidenceKey: `${input.workspaceId}:work_history_gap:missing:${expectedSequence}-${input.startSequence - 1}`,
        sequenceStart: expectedSequence,
        sequenceEnd: input.startSequence - 1,
        gapReason: "missing segment",
      });
      throw new ConvexError(`Work History sequence gap; expected ${expectedSequence}`);
    }
    if (input.startSequence < expectedSequence && !owner.exact) {
      await ctx.runMutation(internal.integritySignals.recordGap, {
        organizationId: owner.organizationId,
        workspaceId: input.workspaceId,
        studentId: owner.studentId,
        evidenceKey: `${input.workspaceId}:work_history_gap:reordered:${input.startSequence}-${input.endSequence}`,
        sequenceStart: Math.max(1, input.startSequence),
        sequenceEnd: Math.max(1, input.endSequence),
        gapReason: "reordered segment",
      });
      throw new ConvexError("Work History range overlaps or is behind committed history");
    }
    if (
      owner.exact &&
      (owner.exact.endSequence !== input.endSequence ||
        owner.exact.eventCount !== input.eventCount ||
        owner.exact.contentHash !== input.contentHash ||
        owner.exact.byteLength !== input.byteLength ||
        owner.exact.snapshotHash !== input.snapshotHash ||
        owner.exact.snapshotByteLength !== input.snapshotByteLength)
    ) {
      await ctx.runMutation(internal.integritySignals.recordGap, {
        organizationId: owner.organizationId,
        workspaceId: input.workspaceId,
        studentId: owner.studentId,
        evidenceKey: `${input.workspaceId}:work_history_gap:unverifiable:${input.startSequence}-${input.endSequence}:${input.contentHash}`,
        sequenceStart: Math.max(1, input.startSequence),
        sequenceEnd: Math.max(1, input.endSequence),
        gapReason: "unverifiable segment",
      });
      throw new ConvexError("Work History range overlaps different content");
    }
    const bytes = new Uint8Array(input.bytes);
    const snapshotBytes = input.snapshotBytes ? new Uint8Array(input.snapshotBytes) : undefined;
    const storage = objectStorageFromEnvironment();
    let decoded;
    let baselineFiles: ReplayFile[] = [];
    try {
      decoded = validateChunkPayload(input, bytes, snapshotBytes);
      if (owner.previous) {
        const previousBytes = await storage.getImmutable(owner.previous);
        baselineFiles = decodeSnapshotPayload(owner.previous.manifest, previousBytes).files;
      }
      if (input.startSequence === expectedSequence) {
        const frames = reconstructReplayFrames(baselineFiles, decoded.events);
        const endingFiles = frames[frames.length - 1]?.files ?? baselineFiles;
        if (!decoded.snapshot || !sameReplayFiles(endingFiles, decoded.snapshot.files)) {
          throw new Error("Work History events do not reconstruct their committed snapshot");
        }
      }
    } catch (error) {
      const reordered =
        error instanceof Error && /missing or reordered sequence/.test(error.message);
      const sequenceStart = Number.isSafeInteger(input.startSequence)
        ? Math.max(1, input.startSequence)
        : 1;
      const sequenceEnd =
        Number.isSafeInteger(input.endSequence) && input.endSequence >= sequenceStart
          ? input.endSequence
          : sequenceStart;
      await ctx.runMutation(internal.integritySignals.recordGap, {
        organizationId: owner.organizationId,
        workspaceId: input.workspaceId,
        studentId: owner.studentId,
        evidenceKey: `${input.workspaceId}:work_history_gap:${reordered ? "reordered" : "unverifiable"}:${sequenceStart}-${sequenceEnd}:${input.contentHash}`,
        sequenceStart,
        sequenceEnd,
        gapReason: reordered ? "reordered segment" : "unverifiable segment",
      });
      throw new ConvexError(error instanceof Error ? error.message : "Invalid Work History chunk");
    }
    const keys = objectKeys(owner.organizationId, input);
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
    const result = await ctx.runMutation(internal.workHistory.commitChunk, {
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
      signalCandidates:
        input.startSequence === expectedSequence
          ? eventSignalCandidates(input.workspaceId, baselineFiles, decoded.events)
          : undefined,
    });
    return result;
  },
});
