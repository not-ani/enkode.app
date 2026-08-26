import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTestBackend() {
  return convexTest(schema, modules);
}

const version = {
  instructions: "Use the helper to print a greeting.",
  runtimeVersion: "3.12.0",
  entrypoint: "main.py",
  starterFiles: [
    { path: "main.py", content: "from helpers import greeting\n" },
    { path: "helpers.py", content: "greeting = 'hello'\n" },
  ],
  evaluationTests: [],
};

async function seed(backend: ReturnType<typeof createTestBackend>) {
  const users = await backend.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      name: "North Academy",
      slug: "north",
    });
    const teacherId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-teacher",
      username: "teacher",
      displayName: "Teacher",
      role: "teacher",
    });
    const studentId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-student",
      username: "student",
      displayName: "Student",
      role: "student",
    });
    const otherStudentId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-other",
      username: "other",
      displayName: "Other Student",
      role: "student",
    });
    return { otherStudentId, studentId, teacherId };
  });
  const teacher = backend.withIdentity({ subject: "auth-teacher" });
  const courseId = await teacher.mutation(api.courses.create, { name: "CS101" });
  const classroomId = await teacher.mutation(api.classrooms.create, { courseId, name: "Period 1" });
  const assignment = await teacher.mutation(api.assignments.create, {
    courseId,
    title: "Greeting",
    ...version,
  });
  await teacher.mutation(api.enrollments.enroll, { classroomId, studentId: users.studentId });
  await teacher.mutation(api.enrollments.enroll, {
    classroomId,
    studentId: users.otherStudentId,
  });
  const assignmentReleaseId = await teacher.mutation(api.assignmentReleases.create, {
    classroomId,
    assignmentVersionId: assignment.assignmentVersionId,
    points: 10,
  });
  return { assignmentReleaseId };
}

describe("Student Workspaces", () => {
  it("initializes one multi-file Workspace from the exact released starter files", async () => {
    const backend = createTestBackend();
    const { assignmentReleaseId } = await seed(backend);
    const student = backend.withIdentity({ subject: "auth-student" });

    const first = await student.mutation(api.workspaces.open, { assignmentReleaseId });
    const resumed = await student.mutation(api.workspaces.open, { assignmentReleaseId });

    expect(resumed._id).toBe(first._id);
    expect(first.files).toEqual(version.starterFiles);
    expect(
      await backend.run(async (ctx) => await ctx.db.query("workspaces").collect()),
    ).toHaveLength(1);
  });

  it("persists every file through explicit save", async () => {
    const backend = createTestBackend();
    const { assignmentReleaseId } = await seed(backend);
    const student = backend.withIdentity({ subject: "auth-student" });
    const workspace = await student.mutation(api.workspaces.open, { assignmentReleaseId });
    const files = [
      { path: "main.py", content: "from helpers import greeting\nprint(greeting)\n" },
      { path: "helpers.py", content: "greeting = 'hi'\n" },
    ];

    await student.mutation(api.workspaces.save, { workspaceId: workspace._id, files });
    const resumed = await student.mutation(api.workspaces.open, { assignmentReleaseId });

    expect(resumed.files).toEqual(files);
  });

  it("isolates each Student's Workspace and rejects cross-Student access", async () => {
    const backend = createTestBackend();
    const { assignmentReleaseId } = await seed(backend);
    const student = backend.withIdentity({ subject: "auth-student" });
    const other = backend.withIdentity({ subject: "auth-other" });
    const first = await student.mutation(api.workspaces.open, { assignmentReleaseId });
    const second = await other.mutation(api.workspaces.open, { assignmentReleaseId });

    expect(second._id).not.toBe(first._id);
    await expect(
      other.mutation(api.workspaces.save, {
        workspaceId: first._id as Id<"workspaces">,
        files: first.files,
      }),
    ).rejects.toThrow("Forbidden");
    expect((await student.mutation(api.workspaces.open, { assignmentReleaseId })).files).toEqual(
      version.starterFiles,
    );
  });

  it("does not let a save add, remove, or reorder released files", async () => {
    const backend = createTestBackend();
    const { assignmentReleaseId } = await seed(backend);
    const student = backend.withIdentity({ subject: "auth-student" });
    const workspace = await student.mutation(api.workspaces.open, { assignmentReleaseId });

    await expect(
      student.mutation(api.workspaces.save, {
        workspaceId: workspace._id,
        files: workspace.files.toReversed(),
      }),
    ).rejects.toThrow("preserve the released file set and order");
  });
});
