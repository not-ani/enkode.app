import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import type { Id } from "./_generated/dataModel";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

async function seed(backend: ReturnType<typeof convexTest>) {
  return await backend.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", { name: "North", slug: "north" });
    const otherOrganizationId = await ctx.db.insert("organizations", {
      name: "South",
      slug: "south",
    });
    const teacherId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "teacher",
      username: "teacher",
      displayName: "Teacher",
      role: "teacher",
    });
    await ctx.db.insert("users", {
      organizationId,
      authUserId: "unassigned",
      username: "unassigned",
      displayName: "Unassigned",
      role: "teacher",
    });
    await ctx.db.insert("users", {
      organizationId: otherOrganizationId,
      authUserId: "outsider",
      username: "outsider",
      displayName: "Outsider",
      role: "teacher",
    });
    const courseId = await ctx.db.insert("courses", { organizationId, name: "CS101" });
    const classroomId = await ctx.db.insert("classrooms", {
      organizationId,
      courseId,
      name: "Period 1",
    });
    await ctx.db.insert("classroomTeachers", { organizationId, classroomId, teacherId });

    const students = {} as Record<string, Id<"users">>;
    for (const [username, displayName, status] of [
      ["alpha", "Alpha", "active"],
      ["beta", "Beta", "active"],
      ["gamma", "Gamma", "active"],
      ["delta", "Delta", "active"],
      ["ended", "Ended", "ended"],
      ["irrelevant", "Irrelevant", "ended"],
    ] as const) {
      const studentId = await ctx.db.insert("users", {
        organizationId,
        authUserId: username,
        username,
        displayName,
        role: "student",
      });
      students[username] = studentId;
      await ctx.db.insert("enrollments", {
        organizationId,
        classroomId,
        studentId,
        status,
        endedAt: status === "ended" ? 100 : undefined,
      });
    }

    async function addRelease(title: string, order: number) {
      const assignmentId = await ctx.db.insert("assignments", {
        organizationId,
        courseId,
        title,
        latestVersion: 1,
      });
      const assignmentVersionId = await ctx.db.insert("assignmentVersions", {
        organizationId,
        assignmentId,
        version: 1,
        instructions: title,
        language: "python",
        runtimeVersion: "3.12.0",
        entrypoint: "main.py",
        createdBy: teacherId,
        createdAt: order,
      });
      const assignmentReleaseId = await ctx.db.insert("assignmentReleases", {
        organizationId,
        classroomId,
        assignmentId,
        assignmentVersionId,
        points: order === 1 ? 10 : 20,
        order,
        publicationState: "published",
        publishedAt: order,
        createdBy: teacherId,
        createdAt: order,
      });
      return { assignmentReleaseId, assignmentVersionId };
    }

    const later = await addRelease("Later", 2);
    const earlier = await addRelease("Earlier", 1);
    await ctx.db.patch(earlier.assignmentReleaseId, {
      deadlinePolicy: "accept_late",
      deadlineAt: 100,
    });

    async function addSubmission(studentId: Id<"users">, attemptNumber: number) {
      const workspaceId = await ctx.db.insert("workspaces", {
        organizationId,
        assignmentReleaseId: earlier.assignmentReleaseId,
        assignmentVersionId: earlier.assignmentVersionId,
        studentId,
        files: [],
        createdAt: attemptNumber,
        updatedAt: attemptNumber,
      });
      const snapshotId = await ctx.db.insert("submissionSnapshots", {
        organizationId,
        workspaceId,
        assignmentVersionId: earlier.assignmentVersionId,
        historySequence: attemptNumber,
        objectKey: `snapshot-${studentId}-${attemptNumber}`,
        contentHash: `snapshot-${attemptNumber}`,
        byteLength: 0,
        files: [],
        createdAt: attemptNumber,
      });
      return await ctx.db.insert("submissions", {
        organizationId,
        workspaceId,
        assignmentReleaseId: earlier.assignmentReleaseId,
        assignmentVersionId: earlier.assignmentVersionId,
        studentId,
        snapshotId,
        idempotencyKey: `${studentId}-${attemptNumber}`,
        attemptNumber,
        runtimeVersion: "3.12.0",
        entrypoint: "main.py",
        execution: {
          status: "completed",
          stdout: "",
          stderr: "",
          exitCode: 0,
          signal: null,
        },
        testResults: [],
        proposedPoints: 6,
        submittedAt: attemptNumber,
      });
    }

    async function addGrade(
      studentId: Id<"users">,
      submissionId: Id<"submissions">,
      points: number,
    ) {
      return await ctx.db.insert("grades", {
        organizationId,
        assignmentReleaseId: earlier.assignmentReleaseId,
        studentId,
        submissionId,
        proposedPoints: 6,
        points,
        inlineFeedback: [],
        updatedBy: teacherId,
        updatedAt: 1,
      });
    }

    const betaSubmission = await addSubmission(students.beta!, 1);
    await ctx.db.patch(betaSubmission, { late: true, effectiveDeadlineAt: 100 });
    await addGrade(students.beta!, betaSubmission, 7);
    const gammaFirst = await addSubmission(students.gamma!, 1);
    const gammaGrade = await addGrade(students.gamma!, gammaFirst, 8);
    const gammaReturn = await ctx.db.insert("gradeReturns", {
      organizationId,
      gradeId: gammaGrade,
      assignmentReleaseId: earlier.assignmentReleaseId,
      studentId: students.gamma!,
      submissionId: gammaFirst,
      proposedPoints: 6,
      points: 8,
      inlineFeedback: [],
      revision: 1,
      returnedBy: teacherId,
      returnedAt: 1,
    });
    await ctx.db.patch(gammaGrade, { latestReturnId: gammaReturn });
    await addSubmission(students.gamma!, 2);
    const deltaSubmission = await addSubmission(students.delta!, 1);
    const deltaGrade = await addGrade(students.delta!, deltaSubmission, 9);
    const deltaReturn = await ctx.db.insert("gradeReturns", {
      organizationId,
      gradeId: deltaGrade,
      assignmentReleaseId: earlier.assignmentReleaseId,
      studentId: students.delta!,
      submissionId: deltaSubmission,
      proposedPoints: 6,
      points: 9,
      inlineFeedback: [],
      revision: 1,
      returnedBy: teacherId,
      returnedAt: 1,
    });
    await ctx.db.patch(deltaGrade, { latestReturnId: deltaReturn });
    await addSubmission(students.ended!, 1);

    return { classroomId, earlier, later, students, teacherId };
  });
}

describe("Classroom Gradebook", () => {
  it("orders releases and Students while deriving exactly one status and points per cell", async () => {
    const backend = convexTest(schema, modules);
    const { classroomId } = await seed(backend);
    const result = (await backend
      .withIdentity({ subject: "teacher" })
      .query(api.gradebook.forClassroom, { classroomId })) as {
      releases: { assignmentTitle: string }[];
      students: {
        displayName: string;
        cells: {
          deadlineFacts: { missing: boolean; late: boolean };
          points?: number;
          status: string;
        }[];
      }[];
    };

    expect(result.releases.map(({ assignmentTitle }) => assignmentTitle)).toEqual([
      "Earlier",
      "Later",
    ]);
    expect(result.students.map(({ displayName }) => displayName)).toEqual([
      "Alpha",
      "Beta",
      "Delta",
      "Ended",
      "Gamma",
    ]);
    expect(
      Object.fromEntries(
        result.students.map((student) => [
          student.displayName,
          student.cells.map(({ points, status }) => ({ points, status })),
        ]),
      ),
    ).toEqual({
      Alpha: [
        { points: undefined, status: "awaiting_submission" },
        { points: undefined, status: "awaiting_submission" },
      ],
      Beta: [
        { points: 7, status: "submitted" },
        { points: undefined, status: "awaiting_submission" },
      ],
      Delta: [
        { points: 9, status: "returned" },
        { points: undefined, status: "awaiting_submission" },
      ],
      Ended: [
        { points: undefined, status: "submitted" },
        { points: undefined, status: "awaiting_submission" },
      ],
      Gamma: [
        { points: 8, status: "awaiting_review" },
        { points: undefined, status: "awaiting_submission" },
      ],
    });
    expect(result.students[0]?.cells[0]?.deadlineFacts).toEqual({ missing: true, late: false });
    expect(result.students[1]?.cells[0]?.deadlineFacts).toEqual({ missing: false, late: true });
    expect(result.students[3]?.cells[1]?.deadlineFacts).toEqual({ missing: false, late: false });
  });

  it("uses an explicit Teacher-controlled excuse instead of Enrollment state", async () => {
    const backend = convexTest(schema, modules);
    const { classroomId, later, students, teacherId } = await seed(backend);
    const teacher = backend.withIdentity({ subject: "teacher" });
    await teacher.mutation(api.gradebook.setExcuse, {
      assignmentReleaseId: later.assignmentReleaseId,
      studentId: students.ended!,
      reason: "Transferred after this unit",
    });

    let gradebook = await teacher.query(api.gradebook.forClassroom, { classroomId });
    const ended = gradebook.students.find(
      ({ username }: { username: string }) => username === "ended",
    )!;
    expect(ended.cells[1]).toMatchObject({
      status: "excused",
      excuseReason: "Transferred after this unit",
    });
    const excuse = await backend.run(async (ctx) =>
      ctx.db
        .query("assignmentExcuses")
        .withIndex("by_release_student", (index) =>
          index
            .eq("assignmentReleaseId", later.assignmentReleaseId)
            .eq("studentId", students.ended!),
        )
        .unique(),
    );
    expect(excuse).toMatchObject({ setBy: teacherId });

    await teacher.mutation(api.gradebook.clearExcuse, {
      assignmentReleaseId: later.assignmentReleaseId,
      studentId: students.ended!,
    });
    gradebook = await teacher.query(api.gradebook.forClassroom, { classroomId });
    expect(
      gradebook.students.find(({ username }: { username: string }) => username === "ended")!
        .cells[1]!.status,
    ).toBe("awaiting_submission");
    const events = await backend.run(async (ctx) =>
      ctx.db
        .query("auditEvents")
        .filter((query) => query.eq(query.field("targetKind"), "assignment_excuse"))
        .collect(),
    );
    expect(events.map(({ action }) => action)).toEqual([
      "assignment_excuse.set",
      "assignment_excuse.cleared",
    ]);
  });

  it("keeps adopted Versions and archived Classrooms available as historical Gradebooks", async () => {
    const backend = convexTest(schema, modules);
    const { classroomId, earlier, teacherId } = await seed(backend);
    const secondVersionId = await backend.run(async (ctx) => {
      const firstVersion = (await ctx.db.get(earlier.assignmentVersionId))!;
      const versionId = await ctx.db.insert("assignmentVersions", {
        organizationId: firstVersion.organizationId,
        assignmentId: firstVersion.assignmentId,
        version: 2,
        instructions: "Adopted",
        language: "python",
        runtimeVersion: "3.12.0",
        entrypoint: "main.py",
        createdBy: teacherId,
        createdAt: 3,
      });
      await ctx.db.patch(firstVersion.assignmentId, { latestVersion: 2 });
      return versionId;
    });
    const teacher = backend.withIdentity({ subject: "teacher" });
    await teacher.mutation(api.assignmentReleases.adoptVersion, {
      assignmentReleaseId: earlier.assignmentReleaseId,
      assignmentVersionId: secondVersionId,
    });
    await teacher.mutation(api.archive.archiveClassroom, { classroomId });
    const [classrooms, gradebook] = await Promise.all([
      teacher.query(api.gradebook.listClassrooms, {}),
      teacher.query(api.gradebook.forClassroom, { classroomId }),
    ]);

    expect(classrooms).toEqual([
      expect.objectContaining({ _id: classroomId, archived: true, courseName: "CS101" }),
    ]);
    expect(gradebook.releases[0]).toMatchObject({
      id: earlier.assignmentReleaseId,
      version: 2,
    });
    expect(secondVersionId).not.toBe(earlier.assignmentVersionId);
    expect(
      gradebook.students.map((student: { displayName: string }) => student.displayName),
    ).toContain("Ended");
  });

  it("allows only assigned Classroom Teachers", async () => {
    const backend = convexTest(schema, modules);
    const { classroomId } = await seed(backend);
    await expect(
      backend.withIdentity({ subject: "unassigned" }).query(api.gradebook.forClassroom, {
        classroomId,
      }),
    ).rejects.toThrow("Forbidden");
    await expect(
      backend.withIdentity({ subject: "outsider" }).query(api.gradebook.forClassroom, {
        classroomId,
      }),
    ).rejects.toThrow("Forbidden");
    await expect(
      backend.withIdentity({ subject: "alpha" }).query(api.gradebook.forClassroom, {
        classroomId,
      }),
    ).rejects.toThrow("Forbidden");
  });
});
