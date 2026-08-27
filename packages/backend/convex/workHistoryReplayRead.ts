"use node";

import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { objectStorageFromEnvironment } from "./objectStorage";
import { decodeSnapshotPayload, validateChunkPayload } from "./workHistoryProtocol";
import { reconstructReplayFrames, sameReplayFiles } from "./workHistoryReplayModel";

export const readNext = action({
  args: { workspaceId: v.id("workspaces"), afterSequence: v.number() },
  handler: async (ctx, input) => {
    const plan = await ctx.runQuery(internal.workHistoryReplay.readPlan, input);
    if (!plan) return undefined;
    const { baseline, chunk } = plan;
    if (!chunk.snapshotObjectKey || !chunk.snapshotHash || !chunk.snapshotByteLength) {
      throw new ConvexError("Work History replay snapshot is unavailable");
    }

    const storage = objectStorageFromEnvironment();
    try {
      const [bytes, snapshotBytes, baselineBytes] = await Promise.all([
        storage.getImmutable({
          key: chunk.objectKey,
          sha256: chunk.contentHash,
          byteLength: chunk.byteLength,
        }),
        storage.getImmutable({
          key: chunk.snapshotObjectKey,
          sha256: chunk.snapshotHash,
          byteLength: chunk.snapshotByteLength,
        }),
        baseline
          ? storage.getImmutable({
              key: baseline.objectKey,
              sha256: baseline.contentHash,
              byteLength: baseline.byteLength,
            })
          : Promise.resolve(undefined),
      ]);
      const decoded = validateChunkPayload(chunk, bytes, snapshotBytes);
      const baselineFiles =
        baseline && baselineBytes
          ? decodeSnapshotPayload(baseline.manifest, baselineBytes).files
          : [];
      const frames = reconstructReplayFrames(baselineFiles, decoded.events);
      const endFiles = frames[frames.length - 1]?.files ?? baselineFiles;
      if (!decoded.snapshot || !sameReplayFiles(endFiles, decoded.snapshot.files)) {
        throw new Error("Work History events do not reconstruct their committed snapshot");
      }
      return {
        baselineFiles,
        events: decoded.events,
        nextSequence: plan.nextSequence,
      };
    } catch (error) {
      throw new ConvexError(error instanceof Error ? error.message : "Work History replay failed");
    }
  },
});
