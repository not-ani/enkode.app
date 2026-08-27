import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { appendAuditEvent } from "./audit";
import { requireCourseCollaborator } from "./authorization";
import { requireWritableCourse, requireWritableMaterial } from "./lifecycleGuards";

const materialContent = v.union(
  v.object({ kind: v.literal("rich_text"), richText: v.string() }),
  v.object({ kind: v.literal("external_link"), externalUrl: v.string() }),
  v.object({ kind: v.literal("file"), attachmentId: v.id("materialAttachments") }),
);

type MaterialContent =
  | { kind: "rich_text"; richText: string }
  | { kind: "external_link"; externalUrl: string }
  | {
      kind: "file";
      attachmentId: Id<"materialAttachments">;
    };

function cleanRequired(value: string, label: string) {
  const cleaned = value.trim();
  if (!cleaned) throw new ConvexError(`${label} is required`);
  return cleaned;
}

function normalizedExternalUrl(value: string) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    return url.toString();
  } catch {
    throw new ConvexError("External link must be a valid HTTP or HTTPS URL");
  }
}

async function insertVersion(
  ctx: MutationCtx,
  material: Doc<"materials">,
  createdBy: Id<"users">,
  content: MaterialContent,
) {
  const version = material.latestVersion + 1;
  let attachmentId: Id<"materialAttachments"> | undefined;
  if (content.kind === "file") {
    const attachment = await ctx.db.get(content.attachmentId);
    if (
      !attachment ||
      attachment.organizationId !== material.organizationId ||
      attachment.courseId !== material.courseId ||
      attachment.createdBy !== createdBy
    ) {
      throw new ConvexError("Uploaded attachment is unavailable");
    }
    const existingVersion = await ctx.db
      .query("materialVersions")
      .filter((filter) => filter.eq(filter.field("attachmentId"), attachment._id))
      .first();
    if (existingVersion) throw new ConvexError("Uploaded attachment is already in use");
    attachmentId = attachment._id;
  }
  const materialVersionId = await ctx.db.insert("materialVersions", {
    organizationId: material.organizationId,
    materialId: material._id,
    version,
    kind: content.kind,
    richText:
      content.kind === "rich_text" ? cleanRequired(content.richText, "Rich text") : undefined,
    externalUrl:
      content.kind === "external_link" ? normalizedExternalUrl(content.externalUrl) : undefined,
    attachmentId,
    createdBy,
    createdAt: Date.now(),
  });
  await ctx.db.patch(material._id, { latestVersion: version });
  return materialVersionId;
}

async function versionSummary(ctx: QueryCtx, version: Doc<"materialVersions">) {
  const attachment = version.attachmentId ? await ctx.db.get(version.attachmentId) : undefined;
  if (version.kind === "file" && !attachment) {
    throw new ConvexError("Material attachment is unavailable");
  }
  return { ...version, attachment: attachment ?? undefined };
}

export const create = mutation({
  args: { courseId: v.id("courses"), title: v.string(), content: materialContent },
  handler: async (ctx, { courseId, title, content }) => {
    const { organization, user } = await requireCourseCollaborator(ctx, courseId);
    await requireWritableCourse(ctx, courseId);
    const materialId = await ctx.db.insert("materials", {
      organizationId: organization._id,
      courseId,
      title: cleanRequired(title, "Material title"),
      latestVersion: 0,
    });
    const material = await ctx.db.get(materialId);
    if (!material) throw new ConvexError("Material could not be created");
    const lastLibraryItem = await ctx.db
      .query("courseLibraryItems")
      .withIndex("by_course", (index) => index.eq("courseId", courseId))
      .order("desc")
      .first();
    await ctx.db.insert("courseLibraryItems", {
      organizationId: organization._id,
      courseId,
      kind: "material",
      materialId,
      order: (lastLibraryItem?.order ?? -1) + 1,
      createdAt: Date.now(),
    });
    const materialVersionId = await insertVersion(ctx, material, user._id, content);
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "material.created",
      target: { kind: "material", id: materialId },
    });
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "material_version.created",
      target: { kind: "material_version", id: materialVersionId },
    });
    return { materialId, materialVersionId };
  },
});

export const createVersion = mutation({
  args: { materialId: v.id("materials"), content: materialContent },
  handler: async (ctx, { materialId, content }) => {
    const material = await requireWritableMaterial(ctx, materialId);
    const { organization, user } = await requireCourseCollaborator(ctx, material.courseId);
    const materialVersionId = await insertVersion(ctx, material, user._id, content);
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "material_version.created",
      target: { kind: "material_version", id: materialVersionId },
    });
    return materialVersionId;
  },
});

export const listByCourse = query({
  args: { courseId: v.id("courses") },
  handler: async (ctx, { courseId }) => {
    await requireCourseCollaborator(ctx, courseId);
    const materials = await ctx.db
      .query("materials")
      .withIndex("by_course", (index) => index.eq("courseId", courseId))
      .collect();
    return materials.filter(({ archivedAt }) => archivedAt === undefined);
  },
});

export const getVersion = query({
  args: { materialVersionId: v.id("materialVersions") },
  handler: async (ctx, { materialVersionId }) => {
    const version = await ctx.db.get(materialVersionId);
    if (!version) throw new ConvexError("Material Version not found");
    const material = await ctx.db.get(version.materialId);
    if (!material) throw new ConvexError("Material not found");
    await requireCourseCollaborator(ctx, material.courseId);
    return await versionSummary(ctx, version);
  },
});

export const authorizeAttachmentUpload = internalQuery({
  args: { courseId: v.id("courses") },
  handler: async (ctx, { courseId }) => {
    const { organization, user } = await requireCourseCollaborator(ctx, courseId);
    await requireWritableCourse(ctx, courseId);
    return { organizationId: organization._id, userId: user._id };
  },
});

export const registerAttachmentUpload = internalMutation({
  args: {
    courseId: v.id("courses"),
    storageProvider: v.string(),
    storageBucket: v.string(),
    storageKey: v.string(),
    filename: v.string(),
    contentType: v.string(),
    byteSize: v.number(),
    sha256: v.string(),
  },
  handler: async (ctx, { courseId, ...metadata }) => {
    const { organization, user } = await requireCourseCollaborator(ctx, courseId);
    await requireWritableCourse(ctx, courseId);
    const existing = await ctx.db
      .query("materialAttachments")
      .withIndex("by_storage_location", (index) =>
        index
          .eq("storageProvider", metadata.storageProvider)
          .eq("storageBucket", metadata.storageBucket)
          .eq("storageKey", metadata.storageKey),
      )
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("materialAttachments", {
      organizationId: organization._id,
      courseId,
      ...metadata,
      createdBy: user._id,
      createdAt: Date.now(),
    });
  },
});
