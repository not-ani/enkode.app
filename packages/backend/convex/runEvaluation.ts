import type { Doc } from "./_generated/dataModel";
import type { ExecutionFile, ExecutionResult, ExecutionService } from "./execution";
import type { AssignmentLanguage } from "./runtimeCatalog";

type EvaluationTest = Doc<"evaluationTests">;

export type PublicTestResult = {
  evaluationTestId: EvaluationTest["_id"];
  name: string;
  passed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export async function evaluateRun(
  execution: ExecutionService,
  input: {
    language?: AssignmentLanguage;
    runtimeVersion: string;
    entrypoint: string;
    files: ExecutionFile[];
    publicTests: EvaluationTest[];
  },
) {
  const executionResult = await execution.execute({
    runtime: { language: input.language ?? "python", version: input.runtimeVersion },
    entrypoint: input.entrypoint,
    files: input.files,
  });
  const publicTestResults: PublicTestResult[] = [];
  for (const test of input.publicTests.filter(({ visibility }) => visibility === "public")) {
    const result = await evaluateTest(execution, input, test);
    publicTestResults.push({
      evaluationTestId: test._id,
      name: test.name,
      passed: result.passed,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }
  return { execution: executionResult, publicTestResults };
}

/** Shared platform-owned test runner used by public Run and full Submission evaluation. */
export async function evaluateTest(
  execution: ExecutionService,
  input: {
    language?: AssignmentLanguage;
    runtimeVersion: string;
    entrypoint: string;
    files: ExecutionFile[];
  },
  test: EvaluationTest,
) {
  const request = (entrypoint: string, files: ExecutionFile[], stdin?: string) =>
    execution.execute({
      runtime: { language: input.language ?? "python", version: input.runtimeVersion },
      entrypoint,
      files,
      stdin,
    });
  let result: ExecutionResult;
  let passed: boolean;
  if (test.kind === "input_output") {
    result = await request(input.entrypoint, input.files, test.stdin);
    passed = result.status === "completed" && result.stdout === test.expectedOutput;
  } else {
    const extension = { python: "py", javascript: "js", typescript: "ts" }[
      input.language ?? "python"
    ];
    let harnessPath = `__enkode_${test.visibility}_test_${test.order}.${extension}`;
    while (input.files.some(({ path }) => path === harnessPath)) harnessPath = `_${harnessPath}`;
    result = await request(harnessPath, [
      { path: harnessPath, content: test.harness! },
      ...input.files,
    ]);
    passed = result.status === "completed";
  }
  return { ...result, passed };
}
