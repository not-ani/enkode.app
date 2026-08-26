import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { requireClassroomTeacher } from "./authorization";
import { deriveAssignmentStatus } from "./gradePolicy";
import { releasePublicationStatus } from "./releasePolicy";

function cellKey(assignmentReleaseId: Id<"assignmentReleases">, studentId: Id<"users">) {
  return `${assignmentReleaseId}:${studentId}`;
}

function newestAttempt(submissions: Doc<"submissions">[]) {
  return submissions.reduce<Doc<"submissions"> | undefined>(
    (latest, submission) =>
      !latest || submission.attemptNumber > latest.attemptNumber ? submission : latest,
    undefined,
  );
}

async function readGradebook(ctx: QueryCtx, classroomId: Id<"classrooms">) {
  const { classroom } = await requireClassroomTeacher(ctx, classroomId);
  const [course, enrollments, assignmentReleases] = await Promise.all([
    ctx.db.get(classroom.courseId),
    ctx.db
      .query("enrollments")
      .withIndex("by_classroom", (index) => index.eq("classroomId", classroomId))
      .collect(),
    ctx.db
      .query("assignmentReleases")
      .withIndex("by_classroom", (index) => index.eq("classroomId", classroomId))
      .collect(),
  ]);
  if (!course) throw new ConvexError("Classroom Course is unavailable");

  const releases = assignmentReleases.sort(
    (left, right) => left.order - right.order || left.createdAt - right.createdAt,
  );
  const releaseRecords = await Promise.all(
    releases.map(async (release) => {
      const [assignment, submissions, grades] = await Promise.all([
        ctx.db.get(release.assignmentId),
        ctx.db
          .query("submissions")
          .withIndex("by_release_student_attempt", (index) =>
            index.eq("assignmentReleaseId", release._id),
          )
          .collect(),
        ctx.db
          .query("grades")
          .withIndex("by_release_student", (index) => index.eq("assignmentReleaseId", release._id))
          .collect(),
      ]);
      if (!assignment) throw new ConvexError("Assignment Release content is unavailable");
      return { assignment, grades, release, submissions };
    }),
  );

  const academicStudentIds = new Set<Id<"users">>();
  for (const { grades, submissions } of releaseRecords) {
    for (const submission of submissions) academicStudentIds.add(submission.studentId);
    for (const grade of grades) academicStudentIds.add(grade.studentId);
  }
  const relevantEnrollments = enrollments.filter(
    (enrollment) => enrollment.status === "active" || academicStudentIds.has(enrollment.studentId),
  );
  const students = await Promise.all(
    relevantEnrollments.map(async (enrollment) => {
      const student = await ctx.db.get(enrollment.studentId);
      if (!student || student.role !== "student") {
        throw new ConvexError("Enrolled Student is unavailable");
      }
      return { enrollment, student };
    }),
  );
  students.sort(
    (left, right) =>
      left.student.displayName.localeCompare(right.student.displayName) ||
      left.student.username.localeCompare(right.student.username),
  );

  const submissionsByCell = new Map<string, Doc<"submissions">[]>();
  const gradesByCell = new Map<string, Doc<"grades">>();
  for (const { grades, release, submissions } of releaseRecords) {
    for (const submission of submissions) {
      const key = cellKey(release._id, submission.studentId);
      const attempts = submissionsByCell.get(key) ?? [];
      attempts.push(submission);
      submissionsByCell.set(key, attempts);
    }
    for (const grade of grades) gradesByCell.set(cellKey(release._id, grade.studentId), grade);
  }
  const returnedAttemptByGrade = new Map<Id<"grades">, number>();
  await Promise.all(
    [...gradesByCell.values()].map(async (grade) => {
      if (!grade.latestReturnId) return;
      const gradeReturn = await ctx.db.get(grade.latestReturnId);
      if (!gradeReturn) throw new ConvexError("Returned Grade is unavailable");
      const submission = await ctx.db.get(gradeReturn.submissionId);
      if (!submission) throw new ConvexError("Returned Grade Submission is unavailable");
      returnedAttemptByGrade.set(grade._id, submission.attemptNumber);
    }),
  );

  return {
    classroom: { id: classroom._id, name: classroom.name, courseName: course.name },
    releases: releaseRecords.map(({ assignment, release }) => ({
      id: release._id,
      assignmentTitle: assignment.title,
      points: release.points,
      order: release.order,
      publicationStatus: releasePublicationStatus(release),
    })),
    students: students.map(({ enrollment, student }) => ({
      id: student._id,
      displayName: student.displayName,
      username: student.username,
      enrollmentStatus: enrollment.status,
      cells: releaseRecords.map(({ release }) => {
        const key = cellKey(release._id, student._id);
        const attempts = submissionsByCell.get(key) ?? [];
        const grade = gradesByCell.get(key);
        const latestSubmission = newestAttempt(attempts);
        return {
          assignmentReleaseId: release._id,
          points: grade?.points,
          status: deriveAssignmentStatus({
            excused: enrollment.status === "ended" && attempts.length === 0 && !grade,
            latestSubmissionAttempt: latestSubmission?.attemptNumber,
            returnedSubmissionAttempt: grade ? returnedAttemptByGrade.get(grade._id) : undefined,
          }),
        };
      }),
    })),
  };
}

export const forClassroom = query({
  args: { classroomId: v.id("classrooms") },
  handler: async (ctx, { classroomId }) => await readGradebook(ctx, classroomId),
});
