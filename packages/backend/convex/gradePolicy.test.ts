import { describe, expect, it } from "vitest";

import { deriveAssignmentStatus, validateGradePoints, validateInlineFeedback } from "./gradePolicy";

describe("Grade policy", () => {
  it("derives review state without mutating a Submission", () => {
    expect(deriveAssignmentStatus({})).toBe("awaiting_submission");
    expect(deriveAssignmentStatus({ latestSubmissionAttempt: 1 })).toBe("submitted");
    expect(
      deriveAssignmentStatus({ latestSubmissionAttempt: 1, returnedSubmissionAttempt: 1 }),
    ).toBe("returned");
    expect(
      deriveAssignmentStatus({ latestSubmissionAttempt: 2, returnedSubmissionAttempt: 1 }),
    ).toBe("awaiting_review");
    expect(deriveAssignmentStatus({ excused: true, latestSubmissionAttempt: 1 })).toBe("excused");
  });

  it("validates score overrides and immutable inline anchors", () => {
    expect(validateGradePoints(7.5, 10)).toBe(7.5);
    expect(() => validateGradePoints(11, 10)).toThrow("between 0 and 10");
    expect(
      validateInlineFeedback({
        path: "main.py",
        snapshotFileContentHash: "a".repeat(64),
        startLine: 2,
        startColumn: 1,
        endLine: 2,
        endColumn: 4,
        body: " Explain this. ",
      }),
    ).toMatchObject({ path: "main.py", body: "Explain this." });
  });
});
