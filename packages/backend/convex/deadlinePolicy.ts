import { ConvexError } from "convex/values";

export type DeadlinePolicy = "no_deadline" | "accept_late" | "hard_close";

export type DeadlineConfiguration = {
  deadlinePolicy?: DeadlinePolicy;
  deadlineAt?: number;
};

export function validateDeadlineConfiguration(input: DeadlineConfiguration) {
  const deadlinePolicy = input.deadlinePolicy ?? "no_deadline";
  if (deadlinePolicy === "no_deadline") {
    if (input.deadlineAt !== undefined) {
      throw new ConvexError("A no-deadline policy cannot have a Deadline");
    }
    return { deadlinePolicy, deadlineAt: undefined };
  }
  if (!Number.isFinite(input.deadlineAt)) {
    throw new ConvexError("This Deadline policy requires a date and time");
  }
  return { deadlinePolicy, deadlineAt: input.deadlineAt };
}

export function validateSubmissionLimit(submissionLimit?: number) {
  if (submissionLimit === undefined) return undefined;
  if (!Number.isSafeInteger(submissionLimit) || submissionLimit < 1) {
    throw new ConvexError("Submission limit must be a positive whole number");
  }
  return submissionLimit;
}

export function effectiveDeadline(
  release: DeadlineConfiguration,
  exception?: DeadlineConfiguration | null,
) {
  return validateDeadlineConfiguration(exception ?? release);
}

export function submissionEligibility(input: {
  deadlinePolicy: DeadlinePolicy;
  deadlineAt?: number;
  submissionLimit?: number;
  attemptsUsed: number;
  now: number;
}) {
  const remainingAttempts =
    input.submissionLimit === undefined
      ? undefined
      : Math.max(0, input.submissionLimit - input.attemptsUsed);
  if (remainingAttempts === 0) {
    return {
      canSubmit: false,
      reason: `All ${input.submissionLimit} submission attempts have been used`,
      late: false,
      remainingAttempts,
    };
  }
  const pastDeadline = input.deadlineAt !== undefined && input.now > input.deadlineAt;
  if (pastDeadline && input.deadlinePolicy === "hard_close") {
    return {
      canSubmit: false,
      reason: "Submissions closed at the Deadline",
      late: false,
      remainingAttempts,
    };
  }
  return {
    canSubmit: true,
    reason: undefined,
    late: pastDeadline && input.deadlinePolicy === "accept_late",
    remainingAttempts,
  };
}

export function deriveDeadlineFacts(input: {
  deadlineAt?: number;
  attemptsUsed: number;
  hasLateSubmission: boolean;
  now: number;
}) {
  return {
    missing:
      input.deadlineAt !== undefined && input.now > input.deadlineAt && input.attemptsUsed === 0,
    late: input.hasLateSubmission,
  };
}
