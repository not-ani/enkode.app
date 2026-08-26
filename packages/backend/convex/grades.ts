import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { appendAuditEvent } from "./audit";
import { requireClassroomTeacher, requireRole } from "./authorization";
import { deriveAssignmentStatus, validateGradePoints, validateInlineFeedback } from "./gradePolicy";
import { requireWritableAssignmentRelease } from "./lifecycleGuards";

const inlineFeedbackInput = v.object({
  path: v.string(),
  startLine: v.number(),
  startColumn: v.number(),
  endLine: v.number(),
  endColumn: v.number(),
  body: v.string(),
});

type DatabaseCtx = QueryCtx | MutationCtx;

async function requireTeacherSubmission(ctx: DatabaseCtx, submissionId: Id<"submissions">) {
  const submission = await ctx.db.get(submissionId);
  if (!submission) throw new ConvexError("Submission not found");
  const release = await ctx.db.get(submission.assignmentReleaseId);
  if (!release) throw new ConvexError("Assignment Release not found");
  const authenticated = await requireClassroomTeacher(ctx, release.classroomId);
  if (submission.organizationId !== authenticated.organization._id) {
    throw new ConvexError("Forbidden");
  }
  const snapshot = await ctx.db.get(submission.snapshotId);
  if (!snapshot) throw new ConvexError("Submission snapshot is unavailable");
  return { ...authenticated, release, snapshot, submission };
}

async function latestReturn(ctx: DatabaseCtx, grade: Doc<"grades"> | null) {
  if (!grade?.latestReturnId) return null;
  return await ctx.db.get(grade.latestReturnId);
}

function newestAttempt(submissions: Doc<"submissions">[]) {
  return submissions.reduce<Doc<"submissions"> | undefined>(
    (latest, submission) =>
      !latest || submission.attemptNumber > latest.attemptNumber ? submission : latest,
    undefined,
  );
}

async function statusFor(
  ctx: DatabaseCtx,
  submissions: Doc<"submissions">[],
  returned: Doc<"gradeReturns"> | null,
) {
  const returnedSubmission = returned ? await ctx.db.get(returned.submissionId) : null;
  return deriveAssignmentStatus({
    latestSubmissionAttempt: newestAttempt(submissions)?.attemptNumber,
    returnedSubmissionAttempt: returnedSubmission?.attemptNumber,
  });
}

export const reviewQueue = query({
  args: { classroomId: v.id("classrooms") },
  handler: async (ctx, { classroomId }) => {
    await requireClassroomTeacher(ctx, classroomId);
    const releases = await ctx.db
      .query("assignmentReleases")
      .withIndex("by_classroom", (index) => index.eq("classroomId", classroomId))
      .collect();
    const rows = await Promise.all(
      releases.map(async (release) => {
        const submissions = await ctx.db
          .query("submissions")
          .withIndex("by_release_student_attempt", (index) =>
            index.eq("assignmentReleaseId", release._id),
          )
          .collect();
        const byStudent = new Map<Id<"users">, Doc<"submissions">[]>();
        for (const submission of submissions) {
          const attempts = byStudent.get(submission.studentId) ?? [];
          attempts.push(submission);
          byStudent.set(submission.studentId, attempts);
        }
        const assignment = await ctx.db.get(release.assignmentId);
        return await Promise.all(
          [...byStudent.entries()].map(async ([studentId, attempts]) => {
            const [student, grade] = await Promise.all([
              ctx.db.get(studentId),
              ctx.db
                .query("grades")
                .withIndex("by_release_student", (index) =>
                  index.eq("assignmentReleaseId", release._id).eq("studentId", studentId),
                )
                .unique(),
            ]);
            const returned = await latestReturn(ctx, grade);
            return {
              assignmentReleaseId: release._id,
              assignmentTitle: assignment?.title ?? "Assignment",
              studentId,
              studentName: student?.displayName ?? "Student",
              attemptCount: attempts.length,
              status: await statusFor(ctx, attempts, returned),
            };
          }),
        );
      }),
    );
    return rows
      .flat()
      .sort((left, right) =>
        left.assignmentTitle === right.assignmentTitle
          ? left.studentName.localeCompare(right.studentName)
          : left.assignmentTitle.localeCompare(right.assignmentTitle),
      );
  },
});

export const review = query({
  args: {
    assignmentReleaseId: v.id("assignmentReleases"),
    studentId: v.id("users"),
  },
  handler: async (ctx, { assignmentReleaseId, studentId }) => {
    const release = await ctx.db.get(assignmentReleaseId);
    if (!release) throw new ConvexError("Assignment Release not found");
    await requireClassroomTeacher(ctx, release.classroomId);
    const submissions = await ctx.db
      .query("submissions")
      .withIndex("by_release_student_attempt", (index) =>
        index.eq("assignmentReleaseId", assignmentReleaseId).eq("studentId", studentId),
      )
      .collect();
    const attempts = await Promise.all(
      submissions
        .sort((left, right) => right.attemptNumber - left.attemptNumber)
        .map(async (submission) => ({
          ...submission,
          snapshotFiles: (await ctx.db.get(submission.snapshotId))?.files ?? [],
        })),
    );
    const grade = await ctx.db
      .query("grades")
      .withIndex("by_release_student", (index) =>
        index.eq("assignmentReleaseId", assignmentReleaseId).eq("studentId", studentId),
      )
      .unique();
    const returned = await latestReturn(ctx, grade);
    return {
      releasePoints: release.points,
      attempts,
      grade,
      returned,
      status: await statusFor(ctx, submissions, returned),
    };
  },
});

export const saveDraft = mutation({
  args: {
    submissionId: v.id("submissions"),
    points: v.number(),
    overallFeedback: v.optional(v.string()),
    inlineFeedback: v.array(inlineFeedbackInput),
  },
  handler: async (ctx, input) => {
    const { release, snapshot, submission, user } = await requireTeacherSubmission(
      ctx,
      input.submissionId,
    );
    await requireWritableAssignmentRelease(ctx, release._id);
    const points = validateGradePoints(input.points, release.points);
    const inlineFeedback = input.inlineFeedback.map((feedback) => {
      const snapshotFile = snapshot.files.find(({ path }) => path === feedback.path.trim());
      if (!snapshotFile) {
        throw new ConvexError("Inline Feedback file is not part of the selected Submission");
      }
      return validateInlineFeedback({
        ...feedback,
        snapshotFileContentHash: snapshotFile.contentHash,
      });
    });
    const overallFeedback = input.overallFeedback?.trim() || undefined;
    const existing = await ctx.db
      .query("grades")
      .withIndex("by_release_student", (index) =>
        index
          .eq("assignmentReleaseId", submission.assignmentReleaseId)
          .eq("studentId", submission.studentId),
      )
      .unique();
    const values = {
      submissionId: submission._id,
      proposedPoints: submission.proposedPoints,
      points,
      overallFeedback,
      inlineFeedback,
      updatedBy: user._id,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, values);
      return existing._id;
    }
    return await ctx.db.insert("grades", {
      organizationId: submission.organizationId,
      assignmentReleaseId: submission.assignmentReleaseId,
      studentId: submission.studentId,
      ...values,
    });
  },
});

export const returnGrade = mutation({
  args: { gradeId: v.id("grades") },
  handler: async (ctx, { gradeId }) => {
    const grade = await ctx.db.get(gradeId);
    if (!grade) throw new ConvexError("Grade not found");
    const { release, submission, user } = await requireTeacherSubmission(ctx, grade.submissionId);
    await requireWritableAssignmentRelease(ctx, release._id);
    if (
      grade.assignmentReleaseId !== submission.assignmentReleaseId ||
      grade.studentId !== submission.studentId
    ) {
      throw new ConvexError("Grade no longer matches its selected Submission");
    }
    const priorReturns = await ctx.db
      .query("gradeReturns")
      .withIndex("by_grade_revision", (index) => index.eq("gradeId", grade._id))
      .collect();
    const revision = priorReturns.length + 1;
    const gradeReturnId = await ctx.db.insert("gradeReturns", {
      organizationId: grade.organizationId,
      gradeId: grade._id,
      assignmentReleaseId: grade.assignmentReleaseId,
      studentId: grade.studentId,
      submissionId: grade.submissionId,
      proposedPoints: grade.proposedPoints,
      points: grade.points,
      overallFeedback: grade.overallFeedback,
      inlineFeedback: grade.inlineFeedback,
      revision,
      returnedBy: user._id,
      returnedAt: Date.now(),
    });
    await ctx.db.patch(grade._id, { latestReturnId: gradeReturnId });
    await appendAuditEvent(ctx, {
      organizationId: release.organizationId,
      actor: { kind: "user", userId: user._id },
      action: revision === 1 ? "grade.returned" : "grade.revised_returned",
      target: { kind: "grade_return", id: gradeReturnId },
    });
    return gradeReturnId;
  },
});

export const mine = query({
  args: { assignmentReleaseId: v.id("assignmentReleases") },
  handler: async (ctx, { assignmentReleaseId }) => {
    const { organization, user } = await requireRole(ctx, "student");
    const release = await ctx.db.get(assignmentReleaseId);
    if (!release || release.organizationId !== organization._id) throw new ConvexError("Forbidden");
    const enrollment = await ctx.db
      .query("enrollments")
      .withIndex("by_classroom_student", (index) =>
        index.eq("classroomId", release.classroomId).eq("studentId", user._id),
      )
      .unique();
    if (!enrollment) throw new ConvexError("Forbidden");
    const submissions = await ctx.db
      .query("submissions")
      .withIndex("by_release_student_attempt", (index) =>
        index.eq("assignmentReleaseId", assignmentReleaseId).eq("studentId", user._id),
      )
      .collect();
    const grade = await ctx.db
      .query("grades")
      .withIndex("by_release_student", (index) =>
        index.eq("assignmentReleaseId", assignmentReleaseId).eq("studentId", user._id),
      )
      .unique();
    const returned = await latestReturn(ctx, grade);
    return {
      status: await statusFor(ctx, submissions, returned),
      returned: returned
        ? {
            submissionId: returned.submissionId,
            proposedPoints: returned.proposedPoints,
            points: returned.points,
            overallFeedback: returned.overallFeedback,
            inlineFeedback: returned.inlineFeedback,
            revision: returned.revision,
            returnedAt: returned.returnedAt,
          }
        : null,
    };
  },
});
