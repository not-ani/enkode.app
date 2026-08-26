import type { Doc } from "./_generated/dataModel";
import type { ExecutionFile, ExecutionResult, ExecutionService } from "./execution";

type PublicTest = Doc<"evaluationTests">;

export type PublicTestResult = {
  evaluationTestId: PublicTest["_id"];
  name: string;
  passed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export async function evaluateRun(
  execution: ExecutionService,
  input: {
    runtimeVersion: string;
    entrypoint: string;
    files: ExecutionFile[];
    publicTests: PublicTest[];
  },
) {
  const request = (entrypoint: string, files: ExecutionFile[], stdin?: string) =>
    execution.execute({
      runtime: { language: "python", version: input.runtimeVersion },
      entrypoint,
      files,
      stdin,
    });
  const executionResult = await request(input.entrypoint, input.files);
  const publicTestResults: PublicTestResult[] = [];
  for (const test of input.publicTests.filter(({ visibility }) => visibility === "public")) {
    let result: ExecutionResult;
    let passed: boolean;
    if (test.kind === "input_output") {
      result = await request(input.entrypoint, input.files, test.stdin);
      passed = result.status === "completed" && result.stdout === test.expectedOutput;
    } else {
      let harnessPath = `__enkode_public_test_${test.order}.py`;
      while (input.files.some(({ path }) => path === harnessPath)) harnessPath = `_${harnessPath}`;
      result = await request(harnessPath, [
        { path: harnessPath, content: test.harness! },
        ...input.files,
      ]);
      passed = result.status === "completed";
    }
    publicTestResults.push({
      evaluationTestId: test._id,
      name: test.name,
      passed,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }
  return { execution: executionResult, publicTestResults };
}
