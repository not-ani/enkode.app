import { describe, expect, it } from "vitest";

import {
  deriveDeadlineFacts,
  effectiveDeadline,
  submissionEligibility,
  validateDeadlineConfiguration,
  validateSubmissionLimit,
} from "./deadlinePolicy";

describe("Deadline and attempt policy", () => {
  it("accepts the exact Deadline boundary and marks only later submissions late", () => {
    expect(
      submissionEligibility({
        deadlinePolicy: "accept_late",
        deadlineAt: 100,
        attemptsUsed: 0,
        now: 100,
      }),
    ).toMatchObject({ canSubmit: true, late: false });
    expect(
      submissionEligibility({
        deadlinePolicy: "accept_late",
        deadlineAt: 100,
        attemptsUsed: 0,
        now: 101,
      }),
    ).toMatchObject({ canSubmit: true, late: true });
  });

  it("hard-closes only after the boundary and applies a Student exception", () => {
    const effective = effectiveDeadline(
      { deadlinePolicy: "hard_close", deadlineAt: 100 },
      { deadlinePolicy: "accept_late", deadlineAt: 200 },
    );
    expect(submissionEligibility({ ...effective, attemptsUsed: 0, now: 150 })).toMatchObject({
      canSubmit: true,
      late: false,
    });
    expect(
      submissionEligibility({
        deadlinePolicy: "hard_close",
        deadlineAt: 100,
        attemptsUsed: 0,
        now: 101,
      }),
    ).toMatchObject({ canSubmit: false, reason: "Submissions closed at the Deadline" });
  });

  it("defaults to unlimited attempts and derives finite remaining attempts", () => {
    expect(
      submissionEligibility({ deadlinePolicy: "no_deadline", attemptsUsed: 300, now: 1 }),
    ).toMatchObject({ canSubmit: true, remainingAttempts: undefined });
    expect(
      submissionEligibility({
        deadlinePolicy: "no_deadline",
        submissionLimit: 2,
        attemptsUsed: 2,
        now: 1,
      }),
    ).toMatchObject({ canSubmit: false, remainingAttempts: 0 });
  });

  it("derives missing and late facts instead of accepting mutable statuses", () => {
    expect(
      deriveDeadlineFacts({ deadlineAt: 100, attemptsUsed: 0, hasLateSubmission: false, now: 101 }),
    ).toEqual({ missing: true, late: false });
    expect(
      deriveDeadlineFacts({ deadlineAt: 100, attemptsUsed: 1, hasLateSubmission: true, now: 101 }),
    ).toEqual({ missing: false, late: true });
  });

  it("rejects incoherent Deadline configurations and invalid limits", () => {
    expect(() =>
      validateDeadlineConfiguration({ deadlinePolicy: "no_deadline", deadlineAt: 100 }),
    ).toThrow("cannot have a Deadline");
    expect(() => validateDeadlineConfiguration({ deadlinePolicy: "hard_close" })).toThrow(
      "requires a date and time",
    );
    expect(() => validateSubmissionLimit(0)).toThrow("positive whole number");
  });
});
