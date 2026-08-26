import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import { studentVisibleEvaluationTest } from "./assignmentPolicy";
import {
  maintainedJavaScriptRuntime,
  maintainedPythonRuntime,
  maintainedRuntimes,
  maintainedTypeScriptRuntime,
  runtimeCanBeRemoved,
} from "./runtimeCatalog";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTestBackend() {
  return convexTest(schema, modules);
}

async function seedCourse(backend: ReturnType<typeof createTestBackend>) {
  return await backend.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      name: "North Academy",
      slug: "north",
    });
    const collaboratorId = await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-collaborator",
      username: "ada",
      displayName: "Ada Lovelace",
      role: "teacher",
    });
    await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-teacher",
      username: "grace",
      displayName: "Grace Hopper",
      role: "teacher",
    });
    await ctx.db.insert("users", {
      organizationId,
      authUserId: "auth-student",
      username: "student",
      displayName: "Student",
      role: "student",
    });
    const courseId = await ctx.db.insert("courses", {
      organizationId,
      name: "CS101",
    });
    await ctx.db.insert("courseCollaborators", {
      organizationId,
      courseId,
      teacherId: collaboratorId,
    });
    return { courseId };
  });
}

const firstVersion = {
  instructions: "Read two numbers and print their sum.",
  runtimeVersion: "3.12.0",
  entrypoint: "main.py",
  starterFiles: [
    { path: "main.py", content: "from helpers import add\n" },
    { path: "helpers.py", content: "def add(a, b):\n    return a + b\n" },
  ],
  evaluationTests: [
    {
      name: "adds positive values",
      kind: "input_output" as const,
      visibility: "public" as const,
      weight: 2,
      stdin: "2 3\n",
      expectedOutput: "5\n",
      passGuidance: "Your program prints the expected sum.",
      failGuidance: "Check the value written to standard output.",
    },
    {
      name: "handles negative values",
      kind: "python_harness" as const,
      visibility: "hidden" as const,
      weight: 3,
      harness: "from helpers import add\nassert add(-2, -3) == -5\n",
      passGuidance: "Negative values work.",
      failGuidance: "Try your helper with two negative values.",
    },
  ],
};

describe("immutable Python Assignment Versions", () => {
  it("lets only Course Collaborators create complete versions", async () => {
    const backend = createTestBackend();
    const { courseId } = await seedCourse(backend);
    const collaborator = backend.withIdentity({ subject: "auth-collaborator" });
    const teacher = backend.withIdentity({ subject: "auth-teacher" });
    const student = backend.withIdentity({ subject: "auth-student" });

    await expect(
      teacher.mutation(api.assignments.create, { courseId, title: "Add", ...firstVersion }),
    ).rejects.toThrow("Forbidden");
    await expect(
      student.mutation(api.assignments.create, { courseId, title: "Add", ...firstVersion }),
    ).rejects.toThrow("Forbidden");
    await expect(teacher.query(api.assignments.supportedRuntime, { courseId })).rejects.toThrow(
      "Forbidden",
    );
    await expect(
      collaborator.query(api.assignments.supportedRuntime, { courseId }),
    ).resolves.toEqual(maintainedPythonRuntime);

    const created = await collaborator.mutation(api.assignments.create, {
      courseId,
      title: "Add two numbers",
      ...firstVersion,
    });
    await expect(
      teacher.mutation(api.assignments.createVersion, {
        assignmentId: created.assignmentId,
        ...firstVersion,
      }),
    ).rejects.toThrow("Forbidden");
    await expect(
      student.query(api.assignments.getVersion, {
        assignmentVersionId: created.assignmentVersionId,
      }),
    ).rejects.toThrow("Forbidden");
    const version = await collaborator.query(api.assignments.getVersion, {
      assignmentVersionId: created.assignmentVersionId,
    });
    expect(version).toMatchObject({
      version: 1,
      language: "python",
      runtimeVersion: "3.12.0",
      entrypoint: "main.py",
    });
    expect(version.starterFiles.map((file: { path: string }) => file.path)).toEqual([
      "main.py",
      "helpers.py",
    ]);
    expect(
      version.evaluationTests.map((test: { kind: string; visibility: string; weight: number }) => [
        test.kind,
        test.visibility,
        test.weight,
      ]),
    ).toEqual([
      ["input_output", "public", 2],
      ["python_harness", "hidden", 3],
    ]);
  });

  it("creates a new snapshot without changing the prior version", async () => {
    const backend = createTestBackend();
    const { courseId } = await seedCourse(backend);
    const collaborator = backend.withIdentity({ subject: "auth-collaborator" });
    const created = await collaborator.mutation(api.assignments.create, {
      courseId,
      title: "Add two numbers",
      ...firstVersion,
    });

    const secondVersionId = await collaborator.mutation(api.assignments.createVersion, {
      assignmentId: created.assignmentId,
      ...firstVersion,
      instructions: "Read any two integers and print their sum.",
      starterFiles: [
        { path: "main.py", content: "from helpers import add\nprint(add(1, 2))\n" },
        firstVersion.starterFiles[1]!,
      ],
    });
    const [original, changed] = await Promise.all([
      collaborator.query(api.assignments.getVersion, {
        assignmentVersionId: created.assignmentVersionId,
      }),
      collaborator.query(api.assignments.getVersion, { assignmentVersionId: secondVersionId }),
    ]);

    expect(original.version).toBe(1);
    expect(original.instructions).toBe(firstVersion.instructions);
    expect(original.starterFiles[0]?.content).toBe("from helpers import add\n");
    expect(changed.version).toBe(2);
    expect(changed.instructions).toContain("any two integers");
  });

  it("accepts only the maintained exact runtime and safe fixed entrypoint", async () => {
    const backend = createTestBackend();
    const { courseId } = await seedCourse(backend);
    const collaborator = backend.withIdentity({ subject: "auth-collaborator" });

    await expect(
      collaborator.mutation(api.assignments.create, {
        courseId,
        title: "Unpinned",
        ...firstVersion,
        runtimeVersion: "3.x",
      }),
    ).rejects.toThrow("exactly pinned maintained Python runtime");
    await expect(
      collaborator.mutation(api.assignments.create, {
        courseId,
        title: "Unsafe",
        ...firstVersion,
        entrypoint: "../main.py",
      }),
    ).rejects.toThrow("safe relative paths");
    await expect(
      collaborator.mutation(api.assignments.create, {
        courseId,
        title: "Shell command",
        ...firstVersion,
        command: "python main.py",
      }),
    ).rejects.toThrow();
  });

  it("redacts hidden test implementation but retains guidance", () => {
    const hidden = firstVersion.evaluationTests[1]!;
    expect(studentVisibleEvaluationTest(hidden)).toEqual({
      name: hidden.name,
      kind: "python_harness",
      visibility: "hidden",
      weight: 3,
      passGuidance: "Negative values work.",
      failGuidance: "Try your helper with two negative values.",
    });
    expect(studentVisibleEvaluationTest(hidden)).not.toHaveProperty("harness");
  });

  it("retains a runtime while any immutable version references it", async () => {
    const backend = createTestBackend();
    const { courseId } = await seedCourse(backend);
    expect(await backend.run((ctx) => runtimeCanBeRemoved(ctx, maintainedPythonRuntime))).toBe(
      true,
    );

    await backend.withIdentity({ subject: "auth-collaborator" }).mutation(api.assignments.create, {
      courseId,
      title: "Add two numbers",
      ...firstVersion,
    });

    expect(await backend.run((ctx) => runtimeCanBeRemoved(ctx, maintainedPythonRuntime))).toBe(
      false,
    );
  });
});

describe.each([
  {
    runtime: maintainedJavaScriptRuntime,
    entrypoint: "main.js",
    kind: "javascript_harness" as const,
  },
  {
    runtime: maintainedTypeScriptRuntime,
    entrypoint: "main.ts",
    kind: "typescript_harness" as const,
  },
])("immutable $runtime.language Assignment Versions", ({ runtime, entrypoint, kind }) => {
  it("authors pinned starter files and supported tests and retains the referenced runtime", async () => {
    const backend = createTestBackend();
    const { courseId } = await seedCourse(backend);
    const collaborator = backend.withIdentity({ subject: "auth-collaborator" });
    await expect(
      collaborator.query(api.assignments.supportedRuntimes, { courseId }),
    ).resolves.toEqual(maintainedRuntimes);
    expect(await backend.run((ctx) => runtimeCanBeRemoved(ctx, runtime))).toBe(true);

    const created = await collaborator.mutation(api.assignments.create, {
      courseId,
      title: `${runtime.language} assignment`,
      language: runtime.language,
      runtimeVersion: runtime.version,
      instructions: "Export the answer.",
      entrypoint,
      starterFiles: [{ path: entrypoint, content: "export const answer = 42;\n" }],
      evaluationTests: [
        {
          name: "exports answer",
          kind,
          visibility: "hidden",
          weight: 2,
          harness: "if (42 !== 42) throw new Error('unreachable');\n",
          failGuidance: "Export the expected value.",
        },
      ],
    });
    const version = await collaborator.query(api.assignments.getVersion, {
      assignmentVersionId: created.assignmentVersionId,
    });

    expect(version).toMatchObject({
      language: runtime.language,
      runtimeVersion: runtime.version,
      entrypoint,
      starterFiles: [expect.objectContaining({ path: entrypoint })],
      evaluationTests: [expect.objectContaining({ kind, visibility: "hidden" })],
    });
    expect(await backend.run((ctx) => runtimeCanBeRemoved(ctx, runtime))).toBe(false);
  });

  it("rejects mismatched runtimes, entrypoints, and native harnesses", async () => {
    const backend = createTestBackend();
    const { courseId } = await seedCourse(backend);
    const collaborator = backend.withIdentity({ subject: "auth-collaborator" });
    const base = {
      courseId,
      title: "Invalid",
      language: runtime.language,
      runtimeVersion: runtime.version,
      instructions: "Invalid",
      entrypoint,
      starterFiles: [{ path: entrypoint, content: "" }],
      evaluationTests: [
        {
          name: "native",
          kind,
          visibility: "public" as const,
          weight: 1,
          harness: "throw new Error('test');",
        },
      ],
    };

    await expect(
      collaborator.mutation(api.assignments.create, {
        ...base,
        runtimeVersion: maintainedPythonRuntime.version,
      }),
    ).rejects.toThrow("exactly pinned maintained");
    await expect(
      collaborator.mutation(api.assignments.create, {
        ...base,
        entrypoint: "main.py",
        starterFiles: [{ path: "main.py", content: "" }],
      }),
    ).rejects.toThrow("entrypoint must end");
    await expect(
      collaborator.mutation(api.assignments.create, {
        ...base,
        evaluationTests: [{ ...base.evaluationTests[0]!, kind: "python_harness" }],
      }),
    ).rejects.toThrow("require");
  });
});
