import { describe, expect, it } from "vitest";

import type { Doc, Id } from "./_generated/dataModel";
import { FakeExecutionService } from "./execution";
import { evaluateSubmission } from "./submissionEvaluation";

const completed = (stdout = "") => ({
  status: "completed" as const,
  stdout,
  stderr: "",
  exitCode: 0,
  signal: null,
});

function test(overrides: Partial<Doc<"evaluationTests">>) {
  return {
    _id: `test-${overrides.visibility ?? "public"}` as Id<"evaluationTests">,
    _creationTime: 1,
    organizationId: "organization" as Id<"organizations">,
    assignmentVersionId: "version" as Id<"assignmentVersions">,
    name: "Case",
    kind: "input_output" as const,
    visibility: "public" as const,
    weight: 2,
    stdin: "input",
    expectedOutput: "expected",
    order: 0,
    ...overrides,
  } satisfies Doc<"evaluationTests">;
}

describe("Submission evaluation", () => {
  it("evaluates public and hidden tests through the Run execution adapter and sums passed weights", async () => {
    const execution = new FakeExecutionService([
      completed("program"),
      completed("expected"),
      completed("wrong"),
    ]);
    const result = await evaluateSubmission(execution, {
      language: "python",
      runtimeVersion: "3.12.0",
      entrypoint: "main.py",
      files: [{ path: "main.py", content: "print('answer')" }],
      tests: [
        test({ passGuidance: "Public passed" }),
        test({
          _id: "hidden" as Id<"evaluationTests">,
          visibility: "hidden",
          weight: 3,
          stdin: "secret input",
          expectedOutput: "secret output",
          failGuidance: "Try the empty-input case.",
          order: 1,
        }),
      ],
    });

    expect(result.proposedPoints).toBe(2);
    expect(result.testResults).toEqual([
      expect.objectContaining({ visibility: "public", passed: true, weight: 2 }),
      expect.objectContaining({
        visibility: "hidden",
        passed: false,
        weight: 3,
        guidance: "Try the empty-input case.",
      }),
    ]);
    expect(execution.requests[2]?.stdin).toBe("secret input");
  });

  it("preserves the public and hidden boundary for Java native tests", async () => {
    const execution = new FakeExecutionService([completed(), completed(), completed()]);
    const result = await evaluateSubmission(execution, {
      language: "java",
      runtimeVersion: "15.0.2",
      entrypoint: "Main.java",
      files: [{ path: "Main.java", content: "public class Main {}" }],
      tests: [
        test({
          kind: "java_harness",
          harness: "    Main.main(new String[0]);",
          stdin: undefined,
          expectedOutput: undefined,
        }),
        test({
          _id: "hidden-java" as Id<"evaluationTests">,
          kind: "java_harness",
          visibility: "hidden",
          harness: "    new Main();",
          stdin: undefined,
          expectedOutput: undefined,
          order: 1,
          weight: 3,
          passGuidance: "The edge case passed.",
        }),
      ],
    });

    expect(result.proposedPoints).toBe(5);
    expect(result.testResults).toEqual([
      expect.objectContaining({ visibility: "public", passed: true }),
      expect.objectContaining({
        visibility: "hidden",
        passed: true,
        guidance: "The edge case passed.",
      }),
    ]);
    expect(execution.requests.every(({ runtime }) => runtime.language === "java")).toBe(true);
    expect(execution.requests.every(({ runtime }) => runtime.version === "15.0.2")).toBe(true);
  });
});
