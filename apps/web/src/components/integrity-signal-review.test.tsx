// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import IntegritySignalReview from "./integrity-signal-review";

afterEach(cleanup);

describe("Integrity Signal review", () => {
  it("shows neutral exact evidence and submits a Teacher review note", async () => {
    const inspect = vi.fn(async () => ({
      event: {
        sequence: 12,
        type: "file_change" as const,
        path: "main.py",
        origin: "paste",
        changes: [{ rangeOffset: 0, rangeLength: 0, text: "code" }],
      },
    }));
    const review = vi.fn(async () => undefined);
    render(
      <IntegritySignalReview
        signals={[
          {
            _id: "signal",
            type: "large_paste",
            state: "open",
            eventSequence: 12,
            path: "main.py",
            insertedCharacters: 220,
            deletedCharacters: 0,
            contribution: 0.75,
          },
        ]}
        inspect={inspect}
        review={review}
      />,
    );

    expect(screen.getByText(/do not determine intent, misconduct, a Grade/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Inspect evidence" }));
    expect(await screen.findByText(/Event 12: main.py · Edit Origin paste/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Optional Teacher note"), {
      target: { value: "Reviewed with the Student." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    await waitFor(() =>
      expect(review).toHaveBeenCalledWith("signal", "reviewed", "Reviewed with the Student."),
    );
  });

  it("shows only narrow cross-Classroom Similarity evidence", async () => {
    const inspect = vi.fn(async () => ({
      similarity: {
        students: [
          { id: "student-1", displayName: "Ada", username: "ada" },
          { id: "student-2", displayName: "Grace", username: "grace" },
        ],
        matchedSpans: [
          {
            path: "main.py",
            start: 20,
            end: 52,
            relatedPath: "helpers.py",
            relatedStart: 4,
            relatedEnd: 36,
            text: "return [score / maximum for score in scores]",
          },
        ],
        provenance: [
          { submissionId: "submission-1", workspaceId: "workspace-1", historySequence: 12 },
          { submissionId: "submission-2", workspaceId: "workspace-2", historySequence: 18 },
        ],
      },
    }));
    render(
      <IntegritySignalReview
        signals={[{ _id: "similarity", type: "similarity", state: "open" }]}
        inspect={inspect}
        review={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByText("Submission evidence")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Inspect evidence" }));
    expect(await screen.findByText("Ada (@ada) and Grace (@grace)")).toBeTruthy();
    expect(screen.getByText(/main.py 20–52 ↔ helpers.py 4–36/)).toBeTruthy();
    expect(screen.getByText("return [score / maximum for score in scores]")).toBeTruthy();
    expect(screen.queryByText(/cheating/i)).toBeNull();
  });
});
