import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

type NotificationType = Doc<"notifications">["type"];
type Event = {
  organizationId: Id<"organizations">;
  classroomId: Id<"classrooms">;
  type: NotificationType;
  dedupeKey: string;
  title: string;
  body: string;
  assignmentReleaseId?: Id<"assignmentReleases">;
  materialReleaseId?: Id<"materialReleases">;
  gradeReturnId?: Id<"gradeReturns">;
  submissionId?: Id<"submissions">;
  studentId?: Id<"users">;
};

async function insertForRecipients(ctx: MutationCtx, recipientIds: Id<"users">[], event: Event) {
  const createdAt = Date.now();
  for (const recipientId of recipientIds) {
    const existing = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_dedupe", (index) =>
        index.eq("recipientId", recipientId).eq("dedupeKey", event.dedupeKey),
      )
      .unique();
    if (existing) continue;
    await ctx.db.insert("notifications", { ...event, recipientId, createdAt });
  }
}

async function activeStudents(ctx: MutationCtx, classroomId: Id<"classrooms">) {
  const enrollments = await ctx.db
    .query("enrollments")
    .withIndex("by_classroom", (index) => index.eq("classroomId", classroomId))
    .collect();
  return enrollments.filter(({ status }) => status === "active").map(({ studentId }) => studentId);
}

export async function notifyAssignmentAvailable(
  ctx: MutationCtx,
  release: Doc<"assignmentReleases">,
) {
  const assignment = await ctx.db.get(release.assignmentId);
  if (!assignment) return;
  await insertForRecipients(ctx, await activeStudents(ctx, release.classroomId), {
    organizationId: release.organizationId,
    classroomId: release.classroomId,
    type: "assignment_available",
    dedupeKey: `assignment-release:${release._id}:available`,
    title: assignment.title,
    body: "A new Assignment is available.",
    assignmentReleaseId: release._id,
  });
}

export async function notifyAssignmentChanged(
  ctx: MutationCtx,
  release: Doc<"assignmentReleases">,
  assignmentVersionId: Id<"assignmentVersions">,
) {
  const assignment = await ctx.db.get(release.assignmentId);
  if (!assignment) return;
  await insertForRecipients(ctx, await activeStudents(ctx, release.classroomId), {
    organizationId: release.organizationId,
    classroomId: release.classroomId,
    type: "assignment_changed",
    dedupeKey: `assignment-release:${release._id}:version:${assignmentVersionId}`,
    title: assignment.title,
    body: "Your teacher updated this Assignment.",
    assignmentReleaseId: release._id,
  });
}

export async function notifyMaterialAvailable(ctx: MutationCtx, release: Doc<"materialReleases">) {
  const material = await ctx.db.get(release.materialId);
  if (!material) return;
  await insertForRecipients(ctx, await activeStudents(ctx, release.classroomId), {
    organizationId: release.organizationId,
    classroomId: release.classroomId,
    type: "material_available",
    dedupeKey: `material-release:${release._id}:available`,
    title: material.title,
    body: "New Material is available.",
    materialReleaseId: release._id,
  });
}

export async function notifyMaterialChanged(
  ctx: MutationCtx,
  release: Doc<"materialReleases">,
  materialVersionId: Id<"materialVersions">,
) {
  const material = await ctx.db.get(release.materialId);
  if (!material) return;
  await insertForRecipients(ctx, await activeStudents(ctx, release.classroomId), {
    organizationId: release.organizationId,
    classroomId: release.classroomId,
    type: "material_changed",
    dedupeKey: `material-release:${release._id}:version:${materialVersionId}`,
    title: material.title,
    body: "Your teacher updated this Material.",
    materialReleaseId: release._id,
  });
}

export async function notifyGradeReturned(ctx: MutationCtx, gradeReturn: Doc<"gradeReturns">) {
  const release = await ctx.db.get(gradeReturn.assignmentReleaseId);
  const assignment = release ? await ctx.db.get(release.assignmentId) : null;
  if (!release || !assignment) return;
  await insertForRecipients(ctx, [gradeReturn.studentId], {
    organizationId: gradeReturn.organizationId,
    classroomId: release.classroomId,
    type: "grade_returned",
    dedupeKey: `grade-return:${gradeReturn._id}`,
    title: assignment.title,
    body: "Your Grade was returned.",
    assignmentReleaseId: release._id,
    gradeReturnId: gradeReturn._id,
  });
}

export async function notifySubmissionNeedsReview(
  ctx: MutationCtx,
  submission: Doc<"submissions">,
) {
  const release = await ctx.db.get(submission.assignmentReleaseId);
  const assignment = release ? await ctx.db.get(release.assignmentId) : null;
  const student = await ctx.db.get(submission.studentId);
  if (!release || !assignment || !student) return;
  const assignments = await ctx.db
    .query("classroomTeachers")
    .withIndex("by_classroom", (index) => index.eq("classroomId", release.classroomId))
    .collect();
  await insertForRecipients(
    ctx,
    assignments.map(({ teacherId }) => teacherId),
    {
      organizationId: submission.organizationId,
      classroomId: release.classroomId,
      type: "submission_needs_review",
      dedupeKey: `submission:${submission._id}:needs-review`,
      title: assignment.title,
      body: `${student.displayName} submitted work for review.`,
      assignmentReleaseId: release._id,
      submissionId: submission._id,
      studentId: submission.studentId,
    },
  );
}
