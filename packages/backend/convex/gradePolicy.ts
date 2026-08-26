import { ConvexError } from "convex/values";

export type AssignmentStatus = "awaiting_submission" | "awaiting_review" | "returned";

export function validateGradePoints(points: number, availablePoints: number) {
  if (!Number.isFinite(points) || points < 0 || points > availablePoints) {
    throw new ConvexError(`Grade points must be between 0 and ${availablePoints}`);
  }
  return points;
}

export function validateInlineFeedback(input: {
  path: string;
  snapshotFileContentHash: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  body: string;
}) {
  const path = input.path.trim();
  const body = input.body.trim();
  if (!path) throw new ConvexError("Inline Feedback requires a file path");
  if (!body) throw new ConvexError("Inline Feedback cannot be empty");
  if (!/^[a-f0-9]{64}$/.test(input.snapshotFileContentHash)) {
    throw new ConvexError("Inline Feedback must reference an immutable snapshot file");
  }
  for (const coordinate of [input.startLine, input.startColumn, input.endLine, input.endColumn]) {
    if (!Number.isSafeInteger(coordinate) || coordinate < 1) {
      throw new ConvexError("Inline Feedback coordinates must be positive integers");
    }
  }
  if (
    input.endLine < input.startLine ||
    (input.endLine === input.startLine && input.endColumn < input.startColumn)
  ) {
    throw new ConvexError("Inline Feedback range must end after it starts");
  }
  return { ...input, path, body };
}

export function deriveAssignmentStatus(input: {
  latestSubmissionAttempt?: number;
  returnedSubmissionAttempt?: number;
}): AssignmentStatus {
  if (input.latestSubmissionAttempt === undefined) return "awaiting_submission";
  if (
    input.returnedSubmissionAttempt !== undefined &&
    input.returnedSubmissionAttempt >= input.latestSubmissionAttempt
  ) {
    return "returned";
  }
  return "awaiting_review";
}
