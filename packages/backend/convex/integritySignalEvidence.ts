"use node";

import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { objectStorageFromEnvironment } from "./objectStorage";
import { validateChunkPayload } from "./workHistoryProtocol";

export const inspect = action({
  args: { signalId: v.id("integritySignals") },
  handler: async (ctx, input) => {
    const plan = await ctx.runQuery(internal.integritySignals.evidencePlan, input);
    if ("similarity" in plan) return { signal: plan.signal, similarity: plan.similarity };
    if (!plan.chunk || plan.signal.eventSequence === undefined) {
      return { signal: plan.signal };
    }
    try {
      if (
        !plan.chunk.snapshotObjectKey ||
        !plan.chunk.snapshotHash ||
        plan.chunk.snapshotByteLength === undefined
      ) {
        throw new Error("Integrity Signal evidence snapshot is unavailable");
      }
      const storage = objectStorageFromEnvironment();
      const [bytes, snapshot] = await Promise.all([
        storage.getImmutable({
          key: plan.chunk.objectKey,
          sha256: plan.chunk.contentHash,
          byteLength: plan.chunk.byteLength,
        }),
        storage.getImmutable({
          key: plan.chunk.snapshotObjectKey,
          sha256: plan.chunk.snapshotHash,
          byteLength: plan.chunk.snapshotByteLength,
        }),
      ]);
      const decoded = validateChunkPayload(plan.chunk, bytes, snapshot);
      const event = decoded.events.find(({ sequence }) => sequence === plan.signal.eventSequence);
      if (!event) throw new Error("Integrity Signal event is unavailable");
      return { signal: plan.signal, event };
    } catch (error) {
      throw new ConvexError(
        error instanceof Error ? error.message : "Integrity Signal evidence is unavailable",
      );
    }
  },
});
