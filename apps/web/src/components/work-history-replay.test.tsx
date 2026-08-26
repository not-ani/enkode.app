// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkHistoryReplay, { type ReplayPage } from "./work-history-replay";

afterEach(cleanup);

const firstPage = {
  baselineFiles: [],
  events: [
    {
      sequence: 1,
      type: "workspace_state",
      files: [
        { path: "main.py", content: "print(message)\n" },
        { path: "message.py", content: "message = 'hello'\n" },
      ],
      observedAt: 1,
    },
    {
      sequence: 2,
      type: "file_change",
      path: "message.py",
      changes: [{ rangeOffset: 10, rangeLength: 7, text: "'hi'" }],
      origin: "paste",
      observedAt: 2,
    },
  ],
  nextSequence: 3,
} satisfies ReplayPage;

describe("Work History replay", () => {
  it("shows exact multi-file state and observed Edit Origin without editing controls", async () => {
    render(<WorkHistoryReplay committedThrough={3} loadPage={async () => firstPage} />);
    await screen.findByText("Sequence 1 of 3");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Edit Origin: Paste")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "message.py" }));
    expect(screen.getByText("message = 'hi'", { exact: false })).toBeTruthy();
    expect(screen.getByText("Read only")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("loads later immutable chunks only when requested", async () => {
    const loadPage = vi.fn(async (afterSequence: number) =>
      afterSequence === 0
        ? firstPage
        : ({
            baselineFiles: [
              { path: "main.py", content: "print(message)\n" },
              { path: "message.py", content: "message = 'hi'\n" },
            ],
            events: [
              {
                sequence: 3,
                type: "file_change",
                path: "main.py",
                changes: [
                  { rangeOffset: 0, rangeLength: 0, text: "from message import message\n" },
                ],
                origin: "completion",
                observedAt: 3,
              },
            ],
          } satisfies ReplayPage),
    );
    render(<WorkHistoryReplay committedThrough={3} loadPage={loadPage} />);
    await screen.findByText("Sequence 1 of 3");
    expect(loadPage).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Load from sequence 3" }));
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith(2));
    expect(loadPage).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Load from sequence 3" })).toBeNull();
  });

  it("labels Run and Submission events without changing the replayed files", async () => {
    render(
      <WorkHistoryReplay
        committedThrough={3}
        loadPage={async () => ({
          baselineFiles: [{ path: "main.py", content: "print('hello')\n" }],
          events: [
            {
              sequence: 2,
              type: "run",
              runId: "run-1",
              status: "completed",
              stdout: "hello\n",
              stderr: "",
              exitCode: 0,
              publicTests: [],
              observedAt: 2,
            },
            {
              sequence: 3,
              type: "submission",
              submissionId: "submission-1",
              attemptNumber: 1,
              proposedPoints: 10,
              observedAt: 3,
            },
          ],
        })}
      />,
    );

    await screen.findByText("Run: completed");
    expect(screen.getByText("print('hello')", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Submitted attempt 1")).toBeTruthy();
    expect(screen.getByText("print('hello')", { exact: false })).toBeTruthy();
  });
});
