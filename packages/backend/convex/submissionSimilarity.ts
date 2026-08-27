"use node";

import { gunzipSync } from "node:zlib";
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";
import { objectStorageFromEnvironment } from "./objectStorage";
import { compareSubmissionFiles, type SimilarityFile } from "./similarityComparison";

function decodeSnapshot(bytes: Uint8Array): SimilarityFile[] {
  const parsed: unknown = JSON.parse(gunzipSync(bytes).toString("utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("files" in parsed) ||
    !Array.isArray(parsed.files)
  ) {
    throw new Error("Submission snapshot is invalid");
  }
  const files = parsed.files;
  if (
    !files.every(
      (file) =>
        file &&
        typeof file === "object" &&
        "path" in file &&
        typeof file.path === "string" &&
        "content" in file &&
        typeof file.content === "string",
    )
  ) {
    throw new Error("Submission snapshot files are invalid");
  }
  return files as SimilarityFile[];
}

export const compare = internalAction({
  args: { submissionId: v.id("submissions") },
  handler: async (ctx, input) => {
    const plan = await ctx.runQuery(internal.submissions.similarityPlan, input);
    const storage = objectStorageFromEnvironment();
    try {
      const currentBytes = await storage.getImmutable({
        key: plan.snapshot.objectKey,
        sha256: plan.snapshot.contentHash,
        byteLength: plan.snapshot.byteLength,
      });
      const files = decodeSnapshot(currentBytes);
      for (let offset = 0; offset < plan.candidates.length; offset += 8) {
        await Promise.all(
          plan.candidates
            .slice(offset, offset + 8)
            .map(
              async ({
                submission,
                snapshot,
              }: {
                submission: Doc<"submissions">;
                snapshot: Doc<"submissionSnapshots">;
              }) => {
                const relatedBytes = await storage.getImmutable({
                  key: snapshot.objectKey,
                  sha256: snapshot.contentHash,
                  byteLength: snapshot.byteLength,
                });
                const matchedSpans = compareSubmissionFiles(
                  files,
                  decodeSnapshot(relatedBytes),
                  plan.starterFiles,
                );
                if (matchedSpans.length === 0) return;
                await ctx.runMutation(internal.integritySignals.recordSimilarity, {
                  submissionId: plan.submission._id,
                  relatedSubmissionId: submission._id,
                  matchedSpans,
                });
              },
            ),
        );
      }
    } catch (error) {
      throw new ConvexError(
        error instanceof Error ? error.message : "Similarity comparison is unavailable",
      );
    }
  },
});
