export type DeleteBlocker = "released" | "submitted" | "graded" | "referenced";

export function permanentDeletionBlocker(input: {
  wasReleased: boolean;
  hasSubmission: boolean;
  hasGrade: boolean;
  hasReference: boolean;
}): DeleteBlocker | undefined {
  if (input.wasReleased) return "released";
  if (input.hasSubmission) return "submitted";
  if (input.hasGrade) return "graded";
  if (input.hasReference) return "referenced";
  return undefined;
}

export function permanentDeletionMessage(blocker: DeleteBlocker) {
  return `Permanent deletion is unavailable because this draft is ${blocker}`;
}
