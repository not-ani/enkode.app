import { describe, expect, it } from "vitest";

import { permanentDeletionBlocker } from "./archivePolicy";

describe("permanent deletion policy", () => {
  it("allows only never-released drafts without academic or external references", () => {
    expect(
      permanentDeletionBlocker({
        wasReleased: false,
        hasSubmission: false,
        hasGrade: false,
        hasReference: false,
      }),
    ).toBeUndefined();
  });

  it.each([
    ["released", { wasReleased: true, hasSubmission: false, hasGrade: false, hasReference: true }],
    [
      "submitted",
      { wasReleased: false, hasSubmission: true, hasGrade: false, hasReference: false },
    ],
    ["graded", { wasReleased: false, hasSubmission: false, hasGrade: true, hasReference: false }],
    [
      "referenced",
      { wasReleased: false, hasSubmission: false, hasGrade: false, hasReference: true },
    ],
  ] as const)("identifies a %s blocker", (expected, input) => {
    expect(permanentDeletionBlocker(input)).toBe(expected);
  });
});
