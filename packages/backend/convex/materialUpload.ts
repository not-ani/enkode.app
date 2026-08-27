"use node";

import { randomUUID } from "node:crypto";
import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { objectStorageFromEnvironment, uploadVerifiedObject } from "./objectStorage";

function cleanFilename(filename: string) {
  const cleaned = filename.trim().replaceAll("/", "_").replaceAll("\\", "_");
  if (!cleaned || cleaned.length > 255) throw new ConvexError("Attachment filename is invalid");
  return cleaned;
}

export const upload = action({
  args: {
    courseId: v.id("courses"),
    filename: v.string(),
    contentType: v.string(),
    bytes: v.bytes(),
  },
  handler: async (ctx, input) => {
    const owner = await ctx.runQuery(internal.materials.authorizeAttachmentUpload, {
      courseId: input.courseId,
    });
    const filename = cleanFilename(input.filename);
    const contentType = input.contentType.trim() || "application/octet-stream";
    const bytes = new Uint8Array(input.bytes);
    if (bytes.byteLength === 0) throw new ConvexError("Attachment cannot be empty");
    const metadata = await uploadVerifiedObject(objectStorageFromEnvironment(), {
      key: `organizations/${owner.organizationId}/material-attachments/${randomUUID()}/${encodeURIComponent(filename)}`,
      bytes,
      filename,
      contentType,
    });
    const attachmentId = await ctx.runMutation(internal.materials.registerAttachmentUpload, {
      courseId: input.courseId,
      ...metadata,
    });
    return { attachmentId, filename, byteSize: bytes.byteLength, sha256: metadata.sha256 };
  },
});
