import type { Doc } from "./_generated/dataModel";
import type { ExecutionFile, ExecutionService } from "./execution";
import { evaluateTest } from "./runEvaluation";

type EvaluationTest = Doc<"evaluationTests">;

export async function evaluateSubmission(
  execution: ExecutionService,
  input: {
    runtimeVersion: string;
    entrypoint: string;
    files: ExecutionFile[];
    tests: EvaluationTest[];
  },
) {
  const executionResult = await execution.execute({
    runtime: { language: "python", version: input.runtimeVersion },
    entrypoint: input.entrypoint,
    files: input.files,
  });
  const testResults = [];
  for (const test of input.tests) {
    const result = await evaluateTest(execution, input, test);
    const guidance = result.passed ? test.passGuidance : test.failGuidance;
    testResults.push({
      evaluationTestId: test._id,
      name: test.name,
      visibility: test.visibility,
      weight: test.weight,
      passed: result.passed,
      ...(guidance === undefined ? {} : { guidance }),
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }
  return {
    execution: executionResult,
    testResults,
    proposedPoints: testResults.reduce(
      (points, result) => points + (result.passed ? result.weight : 0),
      0,
    ),
  };
}
