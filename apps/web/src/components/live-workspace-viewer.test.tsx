// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mutate } = vi.hoisted(() => ({
  mutate: vi.fn(async () => ({ expiresAt: Date.now() + 45_000 })),
}));

vi.mock("convex/react", () => ({
  useMutation: vi.fn(() => mutate),
  useQuery: vi.fn(() => ({
    files: [{ path: "main.py", content: "print('committed')\n" }],
    updatedAt: 1,
    assignmentTitle: "Greeting",
    classroomName: "Period 1",
    studentDisplayName: "Grace Student",
    studentUsername: "grace",
    entrypoint: "main.py",
    runtimeVersion: "3.12.0",
  })),
}));

vi.mock("./workspace-monaco", () => ({
  default: ({ options, value }: { options: { readOnly?: boolean }; value: string }) => (
    <div data-testid="monaco" data-read-only={String(options.readOnly)}>
      {value}
    </div>
  ),
}));

import LiveWorkspaceViewer from "./live-workspace-viewer";

describe("LiveWorkspaceViewer", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders committed files read-only and leaves presence when navigation unmounts it", async () => {
    const view = render(<LiveWorkspaceViewer workspaceId="workspace-1" />);

    expect((await screen.findByTestId("monaco")).getAttribute("data-read-only")).toBe("true");
    expect(screen.getByTestId("monaco").textContent).toContain("print('committed')");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-1" })),
    );
    const callsBeforeUnmount = mutate.mock.calls.length;

    view.unmount();
    await waitFor(() => expect(mutate.mock.calls.length).toBeGreaterThan(callsBeforeUnmount));
  });
});
