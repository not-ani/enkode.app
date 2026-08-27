import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ENKODE_EXECUTION_ENDPOINT;
});

describe("Student Runs", () => {
  it("runs only public tests and records results in Work History without changing the Workspace", async () => {
    const backend = convexTest(schema, modules);
    const seeded = await backend.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", { name: "North", slug: "north" });
      const studentId = await ctx.db.insert("users", {
        organizationId,
        authUserId: "auth-student",
        username: "student",
        displayName: "Student",
        role: "student",
      });
      const courseId = await ctx.db.insert("courses", { organizationId, name: "CS101" });
      const classroomId = await ctx.db.insert("classrooms", {
        organizationId,
        courseId,
        name: "Period 1",
      });
      await ctx.db.insert("enrollments", {
        organizationId,
        classroomId,
        studentId,
        status: "active",
      });
      const assignmentId = await ctx.db.insert("assignments", {
        organizationId,
        courseId,
        title: "Hello",
        latestVersion: 1,
      });
      const assignmentVersionId = await ctx.db.insert("assignmentVersions", {
        organizationId,
        assignmentId,
        version: 1,
        instructions: "Print a greeting",
        language: "python",
        runtimeVersion: "3.12.0",
        entrypoint: "main.py",
        createdBy: studentId,
        createdAt: 1,
      });
      const publicTestId = await ctx.db.insert("evaluationTests", {
        organizationId,
        assignmentVersionId,
        name: "Greets",
        kind: "input_output",
        visibility: "public",
        weight: 1,
        stdin: "",
        expectedOutput: "hello\n",
        order: 0,
      });
      await ctx.db.insert("evaluationTests", {
        organizationId,
        assignmentVersionId,
        name: "Secret edge",
        kind: "input_output",
        visibility: "hidden",
        weight: 1,
        stdin: "secret",
        expectedOutput: "hidden",
        order: 1,
      });
      const assignmentReleaseId = await ctx.db.insert("assignmentReleases", {
        organizationId,
        classroomId,
        assignmentId,
        assignmentVersionId,
        points: 10,
        order: 0,
        publicationState: "published",
        publishedAt: 1,
        createdBy: studentId,
        createdAt: 1,
      });
      const workspaceId = await ctx.db.insert("workspaces", {
        organizationId,
        assignmentReleaseId,
        assignmentVersionId,
        studentId,
        files: [
          { path: "main.py", content: "print('old')\n" },
          { path: "helper.py", content: "value = 'hello'\n" },
        ],
        createdAt: 1,
        updatedAt: 1,
      });
      return { publicTestId, workspaceId };
    });
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ run: { stdout: "hello\n", stderr: "", code: 0, signal: null } }),
        );
      }),
    );
    process.env.ENKODE_EXECUTION_ENDPOINT = "https://piston.fork.test";
    const student = backend.withIdentity({ subject: "auth-student" });
    const files = [
      { path: "main.py", content: "from helper import value\nprint(value)\n" },
      { path: "helper.py", content: "value = 'hello'\n" },
    ];

    const result = await student.action(api.runs.run, { workspaceId: seeded.workspaceId, files });

    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.version === "3.12.0")).toBe(true);
    expect(JSON.stringify(requests)).not.toContain("secret");
    expect(result.publicTestResults).toEqual([
      expect.objectContaining({
        evaluationTestId: seeded.publicTestId,
        name: "Greets",
        passed: true,
      }),
    ]);
    expect(await student.query(api.runs.history, { workspaceId: seeded.workspaceId })).toEqual([
      expect.objectContaining({
        files,
        runtimeVersion: "3.12.0",
        entrypoint: "main.py",
        publicTestResults: [expect.objectContaining({ name: "Greets", passed: true })],
      }),
    ]);
    expect(await backend.run(async (ctx) => (await ctx.db.get(seeded.workspaceId))!.files)).toEqual(
      [
        { path: "main.py", content: "print('old')\n" },
        { path: "helper.py", content: "value = 'hello'\n" },
      ],
    );
    expect(await backend.run(async (ctx) => ctx.db.query("submissions").collect())).toEqual([]);
  });

  it("runs Java through the pinned runtime and excludes hidden harnesses", async () => {
    const backend = convexTest(schema, modules);
    const seeded = await backend.run(async (ctx) => {
      const organizationId = await ctx.db.insert("organizations", { name: "North", slug: "north" });
      const studentId = await ctx.db.insert("users", {
        organizationId,
        authUserId: "auth-java-student",
        username: "java-student",
        displayName: "Java Student",
        role: "student",
      });
      const courseId = await ctx.db.insert("courses", { organizationId, name: "AP CSA" });
      const classroomId = await ctx.db.insert("classrooms", {
        organizationId,
        courseId,
        name: "Period 2",
      });
      await ctx.db.insert("enrollments", {
        organizationId,
        classroomId,
        studentId,
        status: "active",
      });
      const assignmentId = await ctx.db.insert("assignments", {
        organizationId,
        courseId,
        title: "Greeting",
        latestVersion: 1,
      });
      const assignmentVersionId = await ctx.db.insert("assignmentVersions", {
        organizationId,
        assignmentId,
        version: 1,
        instructions: "Print a greeting",
        language: "java",
        runtimeVersion: "15.0.2",
        entrypoint: "Main.java",
        createdBy: studentId,
        createdAt: 1,
      });
      await ctx.db.insert("evaluationTests", {
        organizationId,
        assignmentVersionId,
        name: "Calls greet",
        kind: "java_harness",
        visibility: "public",
        weight: 1,
        harness: "    Main.greet();",
        order: 0,
      });
      await ctx.db.insert("evaluationTests", {
        organizationId,
        assignmentVersionId,
        name: "Secret edge",
        kind: "java_harness",
        visibility: "hidden",
        weight: 1,
        harness: "class SecretHarness {}",
        order: 1,
      });
      const assignmentReleaseId = await ctx.db.insert("assignmentReleases", {
        organizationId,
        classroomId,
        assignmentId,
        assignmentVersionId,
        points: 10,
        order: 0,
        publicationState: "published",
        publishedAt: 1,
        createdBy: studentId,
        createdAt: 1,
      });
      const files = [
        {
          path: "Main.java",
          content:
            'public class Main { public static void main(String[] args) { greet(); } static void greet() { System.out.println("hello"); } }',
        },
      ];
      const workspaceId = await ctx.db.insert("workspaces", {
        organizationId,
        assignmentReleaseId,
        assignmentVersionId,
        studentId,
        files,
        createdAt: 1,
        updatedAt: 1,
      });
      return { files, workspaceId };
    });
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ run: { stdout: "hello\n", stderr: "", code: 0, signal: null } }),
        );
      }),
    );
    process.env.ENKODE_EXECUTION_ENDPOINT = "https://piston.fork.test";

    const result = await backend
      .withIdentity({ subject: "auth-java-student" })
      .action(api.runs.run, { workspaceId: seeded.workspaceId, files: seeded.files });

    expect(requests).toHaveLength(2);
    expect(requests.every(({ language }) => language === "java")).toBe(true);
    expect(requests.every(({ version }) => version === "15.0.2")).toBe(true);
    expect(requests[0]?.files).toEqual([{ name: "Main.java", content: seeded.files[0]!.content }]);
    expect(requests[1]?.files).toEqual([
      expect.objectContaining({ name: "__enkode_public_test_0.java" }),
      { name: "Main.java", content: seeded.files[0]!.content },
    ]);
    expect(JSON.stringify(requests)).not.toContain("SecretHarness");
    expect(result.publicTestResults).toEqual([
      expect.objectContaining({ name: "Calls greet", passed: true }),
    ]);
  });
});
