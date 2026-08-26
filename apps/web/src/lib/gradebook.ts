export type AssignmentStatus =
  | "awaiting_submission"
  | "submitted"
  | "awaiting_review"
  | "returned"
  | "excused";

export type GradebookData = {
  classroom: { id: string; name: string; courseName: string };
  releases: {
    id: string;
    assignmentTitle: string;
    version: number;
    points: number;
    order: number;
    publicationStatus: "draft" | "scheduled" | "published";
  }[];
  students: {
    id: string;
    displayName: string;
    username: string;
    enrollmentStatus: "active" | "ended";
    cells: {
      assignmentReleaseId: string;
      points?: number;
      status: AssignmentStatus;
      deadlineFacts: { missing: boolean; late: boolean };
    }[];
  }[];
};

export const assignmentStatusLabel: Record<AssignmentStatus, string> = {
  awaiting_submission: "Awaiting submission",
  submitted: "Submitted",
  awaiting_review: "Awaiting review",
  returned: "Returned",
  excused: "Excused",
};
