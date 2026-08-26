import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { appendAuditEvent } from "./audit";
import { requireClassroomTeacher, requireRole } from "./authorization";
import {
  isArchived,
  requireWritableClassroom,
  requireWritableMaterial,
  requireWritableMaterialRelease,
} from "./lifecycleGuards";
import { notifyMaterialAvailable, notifyMaterialChanged } from "./notificationEvents";
import { adjacentOrder, releasePublicationStatus, validateScheduledFor } from "./releasePolicy";

const publication = v.union(
  v.literal("immediate"),
  v.literal("draft"),
  v.object({ mode: v.literal("scheduled"), scheduledFor: v.number() }),
);

async function requireActiveEnrollment(
  ctx: QueryCtx,
  classroomId: Id<"classrooms">,
  studentId: Id<"users">,
) {
  const enrollment = await ctx.db
    .query("enrollments")
    .withIndex("by_classroom_student", (index) =>
      index.eq("classroomId", classroomId).eq("studentId", studentId),
    )
    .unique();
  if (!enrollment || enrollment.status !== "active") throw new ConvexError("Forbidden");
}

async function contentSummary(ctx: QueryCtx, version: Doc<"materialVersions">) {
  const attachment = version.attachmentId ? await ctx.db.get(version.attachmentId) : undefined;
  if (version.kind === "file" && !attachment) {
    throw new ConvexError("Material attachment is unavailable");
  }
  return {
    kind: version.kind,
    richText: version.richText,
    externalUrl: version.externalUrl,
    attachment: attachment
      ? {
          storageProvider: attachment.storageProvider,
          storageBucket: attachment.storageBucket,
          storageKey: attachment.storageKey,
          filename: attachment.filename,
          contentType: attachment.contentType,
          byteSize: attachment.byteSize,
          sha256: attachment.sha256,
        }
      : undefined,
  };
}

async function releaseSummary(ctx: QueryCtx, release: Doc<"materialReleases">) {
  const [material, version] = await Promise.all([
    ctx.db.get(release.materialId),
    ctx.db.get(release.materialVersionId),
  ]);
  if (!material || !version) throw new ConvexError("Material Release content is unavailable");
  return {
    ...release,
    materialTitle: material.title,
    version: version.version,
    kind: version.kind,
    publicationStatus: releasePublicationStatus(release),
  };
}

async function requireEditableRelease(
  ctx: Parameters<typeof requireClassroomTeacher>[0],
  materialReleaseId: Id<"materialReleases">,
) {
  const release = await requireWritableMaterialRelease(ctx, materialReleaseId);
  const authenticated = await requireClassroomTeacher(ctx, release.classroomId);
  return { ...authenticated, release };
}

async function auditRelease(
  ctx: Parameters<typeof appendAuditEvent>[0],
  release: Doc<"materialReleases">,
  userId: Id<"users">,
  action: string,
) {
  await appendAuditEvent(ctx, {
    organizationId: release.organizationId,
    actor: { kind: "user", userId },
    action,
    target: { kind: "material_release", id: release._id },
  });
}

export const availableVersions = query({
  args: { classroomId: v.id("classrooms") },
  handler: async (ctx, { classroomId }) => {
    const { classroom } = await requireClassroomTeacher(ctx, classroomId);
    const materials = await ctx.db
      .query("materials")
      .withIndex("by_course", (index) => index.eq("courseId", classroom.courseId))
      .collect();
    const options = await Promise.all(
      materials
        .filter(({ archivedAt }) => archivedAt === undefined)
        .map(async (material) => {
          const versions = await ctx.db
            .query("materialVersions")
            .withIndex("by_material", (index) => index.eq("materialId", material._id))
            .collect();
          return versions.map((version) => ({
            materialId: material._id,
            materialTitle: material.title,
            materialVersionId: version._id,
            version: version.version,
            kind: version.kind,
          }));
        }),
    );
    return options
      .flat()
      .sort((left, right) =>
        left.materialTitle === right.materialTitle
          ? right.version - left.version
          : left.materialTitle.localeCompare(right.materialTitle),
      );
  },
});

export const create = mutation({
  args: {
    classroomId: v.id("classrooms"),
    materialVersionId: v.id("materialVersions"),
    publication: v.optional(publication),
  },
  handler: async (ctx, { classroomId, materialVersionId, publication = "immediate" }) => {
    const { classroom, organization, user } = await requireClassroomTeacher(ctx, classroomId);
    await requireWritableClassroom(ctx, classroomId);
    const version = await ctx.db.get(materialVersionId);
    if (!version || version.organizationId !== organization._id) {
      throw new ConvexError("Material Version not found");
    }
    const material = await ctx.db.get(version.materialId);
    if (!material || material.courseId !== classroom.courseId) {
      throw new ConvexError("Material Version does not belong to this Classroom's Course");
    }
    await requireWritableMaterial(ctx, material._id);
    const existing = await ctx.db
      .query("materialReleases")
      .withIndex("by_classroom_material", (index) =>
        index.eq("classroomId", classroomId).eq("materialId", material._id),
      )
      .unique();
    if (existing) throw new ConvexError("Material is already released to this Classroom");
    const releases = await ctx.db
      .query("materialReleases")
      .withIndex("by_classroom", (index) => index.eq("classroomId", classroomId))
      .collect();
    const now = Date.now();
    const scheduledFor =
      typeof publication === "object"
        ? validateScheduledFor(publication.scheduledFor, now)
        : undefined;
    const publicationState =
      publication === "immediate" ? "published" : publication === "draft" ? "draft" : "scheduled";
    const materialReleaseId = await ctx.db.insert("materialReleases", {
      organizationId: organization._id,
      classroomId,
      materialId: material._id,
      materialVersionId,
      order: releases.length,
      publicationState,
      scheduledFor,
      scheduledBy: scheduledFor === undefined ? undefined : user._id,
      publishedAt: publicationState === "published" ? now : undefined,
      createdBy: user._id,
      createdAt: now,
    });
    const release = await ctx.db.get(materialReleaseId);
    if (!release) throw new ConvexError("Material Release could not be created");
    await auditRelease(ctx, release, user._id, "material_release.created");
    await auditRelease(
      ctx,
      release,
      user._id,
      publicationState === "published"
        ? "material_release.published"
        : publicationState === "draft"
          ? "material_release.draft_saved"
          : "material_release.scheduled",
    );
    if (scheduledFor !== undefined) {
      await ctx.scheduler.runAt(scheduledFor, internal.materialReleases.publishScheduled, {
        materialReleaseId,
        scheduledFor,
      });
    }
    if (publicationState === "published") await notifyMaterialAvailable(ctx, release);
    return materialReleaseId;
  },
});

export const adoptVersion = mutation({
  args: {
    materialReleaseId: v.id("materialReleases"),
    materialVersionId: v.id("materialVersions"),
  },
  handler: async (ctx, { materialReleaseId, materialVersionId }) => {
    const { release, user } = await requireEditableRelease(ctx, materialReleaseId);
    if (release.materialVersionId === materialVersionId) return;
    const version = await ctx.db.get(materialVersionId);
    if (
      !version ||
      version.organizationId !== release.organizationId ||
      version.materialId !== release.materialId
    ) {
      throw new ConvexError("Only a Version of the released Material can be adopted");
    }
    const currentVersion = await ctx.db.get(release.materialVersionId);
    if (!currentVersion) throw new ConvexError("Material Release content is unavailable");
    if (version.version <= currentVersion.version) {
      throw new ConvexError("Adopt a newer Material Version");
    }
    await ctx.db.patch(release._id, { materialVersionId });
    await auditRelease(ctx, release, user._id, "material_release.version_adopted");
    if (releasePublicationStatus(release) === "published") {
      await notifyMaterialChanged(ctx, release, materialVersionId);
    }
  },
});

export const schedule = mutation({
  args: { materialReleaseId: v.id("materialReleases"), scheduledFor: v.number() },
  handler: async (ctx, { materialReleaseId, scheduledFor: requestedTime }) => {
    const { release, user } = await requireEditableRelease(ctx, materialReleaseId);
    const now = Date.now();
    if (releasePublicationStatus(release, now) === "published") {
      throw new ConvexError("A published Material Release cannot be scheduled again");
    }
    const scheduledFor = validateScheduledFor(requestedTime, now);
    if (release.publicationState === "scheduled" && release.scheduledFor === scheduledFor) return;
    await ctx.db.patch(release._id, {
      publicationState: "scheduled",
      scheduledFor,
      scheduledBy: user._id,
      publishedAt: undefined,
    });
    await auditRelease(
      ctx,
      release,
      user._id,
      release.publicationState === "scheduled"
        ? "material_release.schedule_changed"
        : "material_release.scheduled",
    );
    await ctx.scheduler.runAt(scheduledFor, internal.materialReleases.publishScheduled, {
      materialReleaseId,
      scheduledFor,
    });
  },
});

export const cancelSchedule = mutation({
  args: { materialReleaseId: v.id("materialReleases") },
  handler: async (ctx, { materialReleaseId }) => {
    const { release, user } = await requireEditableRelease(ctx, materialReleaseId);
    if (releasePublicationStatus(release) === "published") {
      throw new ConvexError("A published Material Release cannot return to draft");
    }
    if (release.publicationState !== "scheduled") return;
    await ctx.db.patch(release._id, {
      publicationState: "draft",
      scheduledFor: undefined,
      scheduledBy: undefined,
      publishedAt: undefined,
    });
    await auditRelease(ctx, release, user._id, "material_release.schedule_canceled");
  },
});

export const publishNow = mutation({
  args: { materialReleaseId: v.id("materialReleases") },
  handler: async (ctx, { materialReleaseId }) => {
    const { release, user } = await requireEditableRelease(ctx, materialReleaseId);
    if (releasePublicationStatus(release) === "published") return;
    await ctx.db.patch(release._id, {
      publicationState: "published",
      scheduledFor: undefined,
      scheduledBy: undefined,
      publishedAt: Date.now(),
    });
    await auditRelease(ctx, release, user._id, "material_release.published");
    await notifyMaterialAvailable(ctx, release);
  },
});

export const publishScheduled = internalMutation({
  args: { materialReleaseId: v.id("materialReleases"), scheduledFor: v.number() },
  handler: async (ctx, { materialReleaseId, scheduledFor }) => {
    const release = await ctx.db.get(materialReleaseId);
    if (
      !release ||
      release.publicationState !== "scheduled" ||
      release.scheduledFor !== scheduledFor ||
      scheduledFor > Date.now()
    )
      return;
    const [classroom, material] = await Promise.all([
      ctx.db.get(release.classroomId),
      ctx.db.get(release.materialId),
    ]);
    if (!classroom || !material || isArchived(classroom) || isArchived(material)) return;
    const course = await ctx.db.get(classroom.courseId);
    if (!course || isArchived(course)) return;
    await ctx.db.patch(release._id, {
      publicationState: "published",
      scheduledFor: undefined,
      scheduledBy: undefined,
      publishedAt: scheduledFor,
    });
    await auditRelease(
      ctx,
      release,
      release.scheduledBy ?? release.createdBy,
      "material_release.published",
    );
    await notifyMaterialAvailable(ctx, release);
  },
});

export const listForClassroom = query({
  args: { classroomId: v.id("classrooms") },
  handler: async (ctx, { classroomId }) => {
    await requireClassroomTeacher(ctx, classroomId);
    const releases = await ctx.db
      .query("materialReleases")
      .withIndex("by_classroom", (index) => index.eq("classroomId", classroomId))
      .collect();
    const active = [];
    for (const release of releases) {
      const material = await ctx.db.get(release.materialId);
      if (material?.archivedAt === undefined) active.push(release);
    }
    return await Promise.all(active.map((release) => releaseSummary(ctx, release)));
  },
});

export const move = mutation({
  args: {
    materialReleaseId: v.id("materialReleases"),
    direction: v.union(v.literal("up"), v.literal("down")),
  },
  handler: async (ctx, { materialReleaseId, direction }) => {
    const { release, user } = await requireEditableRelease(ctx, materialReleaseId);
    const releases = await ctx.db
      .query("materialReleases")
      .withIndex("by_classroom", (index) => index.eq("classroomId", release.classroomId))
      .collect();
    const targetOrder = adjacentOrder(releases, release.order, direction);
    if (targetOrder === undefined) return;
    const adjacent = releases.find(({ order }) => order === targetOrder);
    if (!adjacent) throw new ConvexError("Material Release order is unavailable");
    await ctx.db.patch(adjacent._id, { order: release.order });
    await ctx.db.patch(release._id, { order: targetOrder });
    await auditRelease(ctx, release, user._id, "material_release.reordered");
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireRole(ctx, "student");
    const enrollments = await ctx.db
      .query("enrollments")
      .withIndex("by_student_status", (index) =>
        index.eq("studentId", user._id).eq("status", "active"),
      )
      .collect();
    const groups = await Promise.all(
      enrollments.map(async (enrollment) => {
        const classroom = await ctx.db.get(enrollment.classroomId);
        if (
          !classroom ||
          classroom.organizationId !== user.organizationId ||
          classroom.archivedAt !== undefined
        )
          return [];
        const course = await ctx.db.get(classroom.courseId);
        if (!course || course.archivedAt !== undefined) return [];
        const releases = await ctx.db
          .query("materialReleases")
          .withIndex("by_classroom", (index) => index.eq("classroomId", classroom._id))
          .collect();
        const published = [];
        for (const release of releases) {
          const material = await ctx.db.get(release.materialId);
          if (
            releasePublicationStatus(release) === "published" &&
            material?.archivedAt === undefined
          )
            published.push(release);
        }
        return await Promise.all(
          published.map(async (release) => ({
            ...(await releaseSummary(ctx, release)),
            classroomName: classroom.name,
          })),
        );
      }),
    );
    return groups.flat();
  },
});

export const open = query({
  args: { materialReleaseId: v.id("materialReleases") },
  handler: async (ctx, { materialReleaseId }) => {
    const { user } = await requireRole(ctx, "student");
    const release = await ctx.db.get(materialReleaseId);
    if (
      !release ||
      release.organizationId !== user.organizationId ||
      releasePublicationStatus(release) !== "published"
    )
      throw new ConvexError("Forbidden");
    await requireActiveEnrollment(ctx, release.classroomId, user._id);
    const [version, classroom] = await Promise.all([
      ctx.db.get(release.materialVersionId),
      ctx.db.get(release.classroomId),
    ]);
    if (!version) throw new ConvexError("Material Release content is unavailable");
    return {
      ...(await releaseSummary(ctx, release)),
      ...(await contentSummary(ctx, version)),
      classroomName: classroom?.name,
    };
  },
});
