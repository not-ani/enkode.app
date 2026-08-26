import { ConvexError, v } from "convex/values";

import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireAuthenticatedUser } from "./authorization";
import { releasePublicationStatus } from "./releasePolicy";

type DatabaseCtx = QueryCtx | MutationCtx;

async function isCurrentlyAuthorized(
  ctx: DatabaseCtx,
  notification: Doc<"notifications">,
  user: Doc<"users">,
) {
  if (
    notification.recipientId !== user._id ||
    notification.organizationId !== user.organizationId
  ) {
    return false;
  }
  if (user.role === "teacher") {
    if (notification.type !== "submission_needs_review") return false;
    const [teacherAssignment, submission, release] = await Promise.all([
      ctx.db
        .query("classroomTeachers")
        .withIndex("by_classroom_teacher", (index) =>
          index.eq("classroomId", notification.classroomId).eq("teacherId", user._id),
        )
        .unique(),
      notification.submissionId ? ctx.db.get(notification.submissionId) : null,
      notification.assignmentReleaseId ? ctx.db.get(notification.assignmentReleaseId) : null,
    ]);
    return Boolean(
      teacherAssignment &&
      submission &&
      release &&
      submission.assignmentReleaseId === release._id &&
      release.classroomId === notification.classroomId &&
      release.organizationId === user.organizationId,
    );
  }
  if (notification.type === "submission_needs_review") return false;
  const enrollment = await ctx.db
    .query("enrollments")
    .withIndex("by_classroom_student", (index) =>
      index.eq("classroomId", notification.classroomId).eq("studentId", user._id),
    )
    .unique();
  if (!enrollment || enrollment.status !== "active") return false;
  if (notification.materialReleaseId) {
    const release = await ctx.db.get(notification.materialReleaseId);
    return Boolean(
      release &&
      release.classroomId === notification.classroomId &&
      release.organizationId === user.organizationId &&
      releasePublicationStatus(release) === "published",
    );
  }
  if (notification.assignmentReleaseId) {
    const [release, gradeReturn] = await Promise.all([
      ctx.db.get(notification.assignmentReleaseId),
      notification.gradeReturnId ? ctx.db.get(notification.gradeReturnId) : null,
    ]);
    return Boolean(
      release &&
      release.classroomId === notification.classroomId &&
      release.organizationId === user.organizationId &&
      releasePublicationStatus(release) === "published" &&
      (notification.type !== "grade_returned" ||
        (gradeReturn &&
          gradeReturn.studentId === user._id &&
          gradeReturn.assignmentReleaseId === release._id)),
    );
  }
  return false;
}

function hrefFor(notification: Doc<"notifications">) {
  if (notification.materialReleaseId) {
    return `/material-releases/${notification.materialReleaseId}`;
  }
  if (
    notification.type === "submission_needs_review" &&
    notification.assignmentReleaseId &&
    notification.studentId
  ) {
    return `/gradebook/${notification.classroomId}/${notification.assignmentReleaseId}/${notification.studentId}`;
  }
  if (notification.assignmentReleaseId) {
    return `/assignment-releases/${notification.assignmentReleaseId}`;
  }
  return "/dashboard";
}

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const { user } = await requireAuthenticatedUser(ctx);
    const notifications = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_created", (index) => index.eq("recipientId", user._id))
      .order("desc")
      .take(50);
    const authorization = await Promise.all(
      notifications.map((notification) => isCurrentlyAuthorized(ctx, notification, user)),
    );
    return notifications.flatMap((notification, index) =>
      authorization[index] ? [{ ...notification, href: hrefFor(notification) }] : [],
    );
  },
});

export const markRead = mutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, { notificationId }) => {
    const { user } = await requireAuthenticatedUser(ctx);
    const notification = await ctx.db.get(notificationId);
    if (!notification || !(await isCurrentlyAuthorized(ctx, notification, user))) {
      throw new ConvexError("Forbidden");
    }
    if (notification.readAt === undefined)
      await ctx.db.patch(notificationId, { readAt: Date.now() });
  },
});
