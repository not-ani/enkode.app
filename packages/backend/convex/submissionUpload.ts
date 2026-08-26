"use node";

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { v } from "convex/values";

import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { executionServiceFromEnvironment } from "./execution";
import { objectStorageFromEnvironment } from "./objectStorage";
import { evaluateSubmission } from "./submissionEvaluation";
import { decodeSnapshotPayload } from "./workHistoryProtocol";

const workspaceFile = v.object({ path: v.string(), content: v.string() });

export const submit = action({
  args: {
    workspaceId: v.id("workspaces"),
    files: v.array(workspaceFile),
    requiredHistorySequence: v.number(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, input): Promise<Record<string, unknown>> => {
    const prepared = await ctx.runQuery(internal.submissions.prepare, input);
    if ("existing" in prepared) return prepared.existing;
    const storage = objectStorageFromEnvironment();
    const historySnapshotBytes = await storage.getImmutable({
      key: prepared.historySnapshot.objectKey,
      sha256: prepared.historySnapshot.contentHash,
      byteLength: prepared.historySnapshot.byteLength,
    });
    const finalizedFiles = decodeSnapshotPayload(
      prepared.historySnapshot.manifest,
      historySnapshotBytes,
    ).files;
    if (
      finalizedFiles.length !== prepared.files.length ||
      finalizedFiles.some(
        (file, index) =>
          file.path !== prepared.files[index]?.path ||
          file.content !== prepared.files[index]?.content,
      )
    ) {
      throw new Error("Finalized Work History does not match the submitted Workspace");
    }
    const snapshotPayload = gzipSync(
      JSON.stringify({
        version: 1,
        workspaceId: input.workspaceId,
        assignmentVersionId: prepared.assignmentVersionId,
        historySequence: prepared.requiredHistorySequence,
        files: prepared.files,
      }),
    );
    const contentHash = createHash("sha256").update(snapshotPayload).digest("hex");
    const objectKey = `organizations/${prepared.organizationId}/workspaces/${input.workspaceId}/submissions/${contentHash}.json.gz`;
    await storage.putImmutable({
      key: objectKey,
      bytes: snapshotPayload,
      contentType: "application/gzip",
      sha256: contentHash,
    });
    const evaluated = await evaluateSubmission(executionServiceFromEnvironment(), {
      language: prepared.language,
      runtimeVersion: prepared.runtimeVersion,
      entrypoint: prepared.entrypoint,
      files: prepared.files,
      tests: prepared.tests,
    });
    return await ctx.runMutation(internal.submissions.record, {
      workspaceId: input.workspaceId,
      organizationId: prepared.organizationId,
      studentId: prepared.studentId,
      assignmentReleaseId: prepared.assignmentReleaseId,
      assignmentVersionId: prepared.assignmentVersionId,
      language: prepared.language,
      runtimeVersion: prepared.runtimeVersion,
      entrypoint: prepared.entrypoint,
      historySequence: prepared.requiredHistorySequence,
      idempotencyKey: prepared.idempotencyKey,
      snapshot: {
        objectKey,
        contentHash,
        byteLength: snapshotPayload.byteLength,
        files: prepared.files.map(({ path, content }: { path: string; content: string }) => ({
          path,
          contentHash: createHash("sha256").update(content).digest("hex"),
          byteLength: Buffer.byteLength(content),
        })),
      },
      ...evaluated,
    });
  },
});
