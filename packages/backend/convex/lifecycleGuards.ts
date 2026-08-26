import { ConvexError } from "convex/values";

import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

type DatabaseCtx = MutationCtx | QueryCtx;

function readOnly(kind: string): never {
  throw new ConvexError(`Archived ${kind} is read-only`);
}

export async function requireWritableCourse(ctx: DatabaseCtx, courseId: Id<"courses">) {
  const course = await ctx.db.get(courseId);
  if (!course) throw new ConvexError("Course not found");
  if (course.archivedAt !== undefined) readOnly("Course");
  return course;
}

export async function requireWritableClassroom(ctx: DatabaseCtx, classroomId: Id<"classrooms">) {
  const classroom = await ctx.db.get(classroomId);
  if (!classroom) throw new ConvexError("Classroom not found");
  if (classroom.archivedAt !== undefined) readOnly("Classroom");
  return classroom;
}

export async function requireWritableAssignment(ctx: DatabaseCtx, assignmentId: Id<"assignments">) {
  const assignment = await ctx.db.get(assignmentId);
  if (!assignment) throw new ConvexError("Assignment not found");
  if (assignment.archivedAt !== undefined) readOnly("Assignment");
  await requireWritableCourse(ctx, assignment.courseId);
  return assignment;
}

export async function requireWritableMaterial(ctx: DatabaseCtx, materialId: Id<"materials">) {
  const material = await ctx.db.get(materialId);
  if (!material) throw new ConvexError("Material not found");
  if (material.archivedAt !== undefined) readOnly("Material");
  await requireWritableCourse(ctx, material.courseId);
  return material;
}

export async function requireWritableAssignmentRelease(
  ctx: DatabaseCtx,
  assignmentReleaseId: Id<"assignmentReleases">,
) {
  const release = await ctx.db.get(assignmentReleaseId);
  if (!release) throw new ConvexError("Assignment Release not found");
  await requireWritableClassroom(ctx, release.classroomId);
  await requireWritableAssignment(ctx, release.assignmentId);
  return release;
}

export async function requireWritableMaterialRelease(
  ctx: DatabaseCtx,
  materialReleaseId: Id<"materialReleases">,
) {
  const release = await ctx.db.get(materialReleaseId);
  if (!release) throw new ConvexError("Material Release not found");
  await requireWritableClassroom(ctx, release.classroomId);
  await requireWritableMaterial(ctx, release.materialId);
  return release;
}

export function isArchived(doc: { archivedAt?: number }) {
  return doc.archivedAt !== undefined;
}
