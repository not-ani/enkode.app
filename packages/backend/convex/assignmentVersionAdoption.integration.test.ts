import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTestBackend() {
  return convexTest(schema, modules);
}

const firstVersion = {
  instructions: "Print a greeting.",
  runtimeVersion: "3.12.0",
  entrypoint: "main.py",
  starterFiles: [{ path: "main.py", content: "print('hello')\n" }],
  evaluationTests: [
    {
      name: "greets",
      kind: "input_output" as const,
      visibility: "public" as const,
      weight: 1,
      stdin: "",
      expectedOutput: "hello\n",
    },
  ],
};

async function seed(backend: ReturnType<typeof createTestBackend>) {
  const { studentId } = await backend.run(async (ctx) => {
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
    return { studentId, teacherId };
  });
  const teacher = backend.withIdentity({ subject: "auth-teacher" });
  const student = backend.withIdentity({ subject: "auth-student" });
  const courseId = await teacher.mutation(api.courses.create, { name: "CS101" });
  const classroomId = await teacher.mutation(api.classrooms.create, { courseId, name: "Period 1" });
  const assignment = await teacher.mutation(api.assignments.create, {
    courseId,
    title: "Greeting",
    ...firstVersion,
  });
  await teacher.mutation(api.enrollments.enroll, { classroomId, studentId });
  const assignmentReleaseId = await teacher.mutation(api.assignmentReleases.create, {
    classroomId,
    assignmentVersionId: assignment.assignmentVersionId,
    points: 10,
  });
  const workspace = await student.mutation(api.workspaces.open, { assignmentReleaseId });
  await student.mutation(api.workspaces.save, {
    workspaceId: workspace._id,
    files: [{ path: "main.py", content: "name = 'Ada'\nprint(name)\n" }],
  });
  const secondVersionId = await teacher.mutation(api.assignments.createVersion, {
    assignmentId: assignment.assignmentId,
    ...firstVersion,
    instructions: "Print a personalized greeting and read the notes.",
    starterFiles: [
      { path: "main.py", content: "name = 'student'\nprint(f'Hello {name}')\n" },
      { path: "notes.txt", content: "Personalize the greeting.\n" },
    ],
    evaluationTests: [
      firstVersion.evaluationTests[0]!,
      {
        name: "personalized",
        kind: "python_harness",
        visibility: "hidden",
        weight: 2,
        harness: "assert True\n",
        failGuidance: "Use a name in the greeting.",
      },
    ],
  });
  return {
    assignmentReleaseId,
    classroomId,
    firstVersionId: assignment.assignmentVersionId,
    secondVersionId,
    student,
    teacher,
    workspaceId: workspace._id,
  };
}

describe("Assignment Version adoption", () => {
  it("previews and explicitly adopts content while leaving the Student Workspace untouched", async () => {
    const backend = createTestBackend();
    const context = await seed(backend);

    const before = await context.teacher.query(api.assignmentReleases.listForClassroom, {
      classroomId: context.classroomId,
    });
    expect(before[0]?.assignmentVersionId).toBe(context.firstVersionId);

    const preview = await context.teacher.query(api.assignmentReleases.previewAdoption, {
      assignmentReleaseId: context.assignmentReleaseId,
      assignmentVersionId: context.secondVersionId,
    });
    expect(preview).toMatchObject({
      fromVersion: { version: 1, instructions: "Print a greeting." },
      toVersion: { version: 2, instructions: "Print a personalized greeting and read the notes." },
      changedStarterFiles: [
        { path: "main.py", kind: "modified" },
        { path: "notes.txt", kind: "added" },
      ],
    });

    const adopted = await context.teacher.mutation(api.assignmentReleases.adoptVersion, {
      assignmentReleaseId: context.assignmentReleaseId,
      assignmentVersionId: context.secondVersionId,
    });
    expect(adopted.workspacesAwaitingMerge).toBe(1);
    const [release, workspace, studentRelease] = await Promise.all([
      backend.run((ctx) => ctx.db.get(context.assignmentReleaseId as Id<"assignmentReleases">)),
      context.student.mutation(api.workspaces.open, {
        assignmentReleaseId: context.assignmentReleaseId,
      }),
      context.student.query(api.assignmentReleases.open, {
        assignmentReleaseId: context.assignmentReleaseId,
      }),
    ]);
    expect(release?.assignmentVersionId).toBe(context.secondVersionId);
    expect(studentRelease).toMatchObject({
      version: 2,
      instructions: preview.toVersion.instructions,
    });
    expect(workspace).toMatchObject({
      assignmentVersionId: context.firstVersionId,
      files: [{ path: "main.py", content: "name = 'Ada'\nprint(name)\n" }],
      versionMerge: { fromVersion: 1, toVersion: 2 },
    });
    expect(
      await context.student.query(internal.runs.prepare, {
        workspaceId: workspace._id,
        files: workspace.files,
      }),
    ).toMatchObject({
      assignmentVersionId: context.firstVersionId,
      publicTests: [expect.objectContaining({ name: "greets" })],
    });
  });

  it("requires acknowledged history and an explicit choice for every changed starter file", async () => {
    const backend = createTestBackend();
    const context = await seed(backend);
    await context.teacher.mutation(api.assignmentReleases.adoptVersion, {
      assignmentReleaseId: context.assignmentReleaseId,
      assignmentVersionId: context.secondVersionId,
    });
    const pending = await context.student.mutation(api.workspaces.open, {
      assignmentReleaseId: context.assignmentReleaseId,
    });
    const decisions = [
      { path: "main.py", choice: "keep_current" as const },
      { path: "notes.txt", choice: "accept_new" as const },
    ];

    await expect(
      context.student.mutation(api.workspaces.completeVersionMerge, {
        mergeId: pending.versionMerge!.mergeId,
        decisions,
        acknowledged: false,
        requiredHistorySequence: 3,
      }),
    ).rejects.toThrow("Acknowledge");
    await backend.run((ctx) =>
      ctx.db.patch(context.workspaceId as Id<"workspaces">, { historyAckSequence: 3 }),
    );
    await expect(
      context.student.mutation(api.workspaces.completeVersionMerge, {
        mergeId: pending.versionMerge!.mergeId,
        decisions,
        acknowledged: true,
        requiredHistorySequence: 3,
      }),
    ).rejects.toThrow("does not contain this Assignment Version merge");
    await backend.run(async (ctx) => {
      const workspace = (await ctx.db.get(context.workspaceId as Id<"workspaces">))!;
      await ctx.db.insert("workspaceAssignmentVersionMergeEvents", {
        organizationId: workspace.organizationId,
        workspaceId: workspace._id,
        sequence: 2,
        fromAssignmentVersionId: String(context.firstVersionId),
        toAssignmentVersionId: String(context.secondVersionId),
        acceptedPaths: ["notes.txt"],
        committedAt: Date.now(),
      });
    });
    await expect(
      context.student.mutation(api.workspaces.completeVersionMerge, {
        mergeId: pending.versionMerge!.mergeId,
        decisions: decisions.slice(0, 1),
        acknowledged: true,
        requiredHistorySequence: 3,
      }),
    ).rejects.toThrow();

    const completed = await context.student.mutation(api.workspaces.completeVersionMerge, {
      mergeId: pending.versionMerge!.mergeId,
      decisions,
      acknowledged: true,
      requiredHistorySequence: 3,
    });
    expect(completed).toMatchObject({
      assignmentVersionId: context.secondVersionId,
      files: [
        { path: "main.py", content: "name = 'Ada'\nprint(name)\n" },
        { path: "notes.txt", content: "Personalize the greeting.\n" },
      ],
    });
    expect(completed.versionMerge).toBeUndefined();
    const events = await backend.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(events.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        "assignment_release.version_adopted",
        "workspace.assignment_version_merged",
      ]),
    );
  });

  it("rejects adoption by unassigned users and adoption of the current or an older version", async () => {
    const backend = createTestBackend();
    const context = await seed(backend);
    await expect(
      context.student.query(api.assignmentReleases.previewAdoption, {
        assignmentReleaseId: context.assignmentReleaseId,
        assignmentVersionId: context.secondVersionId,
      }),
    ).rejects.toThrow("Forbidden");
    await expect(
      context.teacher.mutation(api.assignmentReleases.adoptVersion, {
        assignmentReleaseId: context.assignmentReleaseId,
        assignmentVersionId: context.firstVersionId,
      }),
    ).rejects.toThrow("newer");
  });
});
