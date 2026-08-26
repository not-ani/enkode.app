import { ConvexError } from "convex/values";

type EvaluationTest = {
  name: string;
  kind: "input_output" | "python_harness" | "java_harness";
  visibility: "public" | "hidden";
  weight: number;
  stdin?: string;
  expectedOutput?: string;
  harness?: string;
  passGuidance?: string;
  failGuidance?: string;
};

export function validateFilePath(path: string) {
  const cleaned = path.trim();
  if (
    !cleaned ||
    cleaned.startsWith("/") ||
    cleaned.includes("\\") ||
    cleaned.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new ConvexError("Starter file paths must be safe relative paths");
  }
  return cleaned;
}

export function validateEvaluationTest(test: EvaluationTest, language: "python" | "java") {
  if (!test.name.trim()) throw new ConvexError("Evaluation Test name is required");
  if (!Number.isFinite(test.weight) || test.weight < 0) {
    throw new ConvexError("Evaluation Test weight must be zero or greater");
  }
  if (test.kind === "input_output") {
    if (
      test.stdin === undefined ||
      test.expectedOutput === undefined ||
      test.harness !== undefined
    ) {
      throw new ConvexError("Input/output tests require input and expected output only");
    }
  } else if (
    !test.harness?.trim() ||
    test.stdin !== undefined ||
    test.expectedOutput !== undefined
  ) {
    throw new ConvexError("Language-native harness tests require harness source only");
  }
  if (test.kind !== "input_output" && test.kind !== `${language}_harness`) {
    throw new ConvexError(`Harness tests must match the ${language} Assignment language`);
  }
}

export function studentVisibleEvaluationTest(test: EvaluationTest) {
  if (test.visibility === "public") return test;
  return {
    name: test.name,
    kind: test.kind,
    visibility: test.visibility,
    weight: test.weight,
    passGuidance: test.passGuidance,
    failGuidance: test.failGuidance,
  };
}
