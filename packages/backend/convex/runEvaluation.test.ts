import { describe, expect, it } from "vitest";

import type { Doc, Id } from "./_generated/dataModel";
import { FakeExecutionService } from "./execution";
import { evaluateRun } from "./runEvaluation";

const completed = (stdout = "") => ({
  status: "completed" as const,
  stdout,
  stderr: "",
  exitCode: 0,
  signal: null,
});

function test(overrides: Partial<Doc<"evaluationTests">>) {
  return {
    _id: "test" as Id<"evaluationTests">,
    _creationTime: 1,
    organizationId: "organization" as Id<"organizations">,
    assignmentVersionId: "version" as Id<"assignmentVersions">,
    name: "Prints the answer",
    kind: "input_output" as const,
    visibility: "public" as const,
    weight: 1,
    stdin: "answer\n",
    expectedOutput: "42\n",
    order: 0,
    ...overrides,
  } satisfies Doc<"evaluationTests">;
}

describe("public Run evaluation", () => {
  it("uses the deterministic execution boundary for runtime output and public tests", async () => {
    const execution = new FakeExecutionService([completed("ready\n"), completed("42\n")]);
    const files = [
      { path: "helpers.py", content: "answer = 42\n" },
      { path: "main.py", content: "from helpers import answer\nprint(answer)\n" },
    ];

    await expect(
      evaluateRun(execution, {
        runtimeVersion: "3.12.0",
        entrypoint: "main.py",
        files,
        publicTests: [test({})],
      }),
    ).resolves.toMatchObject({
      execution: { stdout: "ready\n" },
      publicTestResults: [{ name: "Prints the answer", passed: true }],
    });
    expect(execution.requests).toEqual([
      {
        runtime: { language: "python", version: "3.12.0" },
        entrypoint: "main.py",
        files,
        stdin: undefined,
      },
      {
        runtime: { language: "python", version: "3.12.0" },
        entrypoint: "main.py",
        files,
        stdin: "answer\n",
      },
    ]);
  });

  it("runs a platform-owned Python harness without exposing arbitrary commands", async () => {
    const execution = new FakeExecutionService([completed(), completed()]);
    await evaluateRun(execution, {
      runtimeVersion: "3.12.0",
      entrypoint: "main.py",
      files: [{ path: "main.py", content: "answer = 42\n" }],
      publicTests: [
        test({
          kind: "python_harness",
          stdin: undefined,
          expectedOutput: undefined,
          harness: "from main import answer\nassert answer == 42\n",
        }),
      ],
    });

    expect(execution.requests[1]).toMatchObject({
      entrypoint: "__enkode_public_test_0.py",
      files: [
        {
          path: "__enkode_public_test_0.py",
          content: "from main import answer\nassert answer == 42\n",
        },
        { path: "main.py", content: "answer = 42\n" },
      ],
    });
  });

  it("defensively ignores hidden Evaluation Tests at the Run boundary", async () => {
    const execution = new FakeExecutionService([completed()]);
    const result = await evaluateRun(execution, {
      runtimeVersion: "3.12.0",
      entrypoint: "main.py",
      files: [{ path: "main.py", content: "print('hello')\n" }],
      publicTests: [test({ visibility: "hidden", stdin: "secret", expectedOutput: "secret" })],
    });

    expect(execution.requests).toHaveLength(1);
    expect(result.publicTestResults).toEqual([]);
  });
});
