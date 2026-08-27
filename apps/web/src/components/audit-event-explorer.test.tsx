// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { useQuery } from "convex/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import AuditEventExplorer from "./audit-event-explorer";

vi.mock("convex/react", () => ({ useQuery: vi.fn() }));

afterEach(cleanup);

describe("Audit Event explorer", () => {
  it("shows the immutable action, actor, resource, and timestamp separately from Work History", () => {
    vi.mocked(useQuery).mockReturnValue([
      {
        id: "event-1",
        action: "workspace.live_view_opened",
        actor: {
          kind: "user",
          id: "teacher-1",
          displayName: "Ada Teacher",
          username: "ada",
        },
        resource: { kind: "workspace", id: "workspace-1" },
        occurredAt: Date.parse("2026-08-26T16:00:00.000Z"),
      },
    ]);

    render(<AuditEventExplorer />);

    expect(screen.getByText("workspace · live view opened")).toBeTruthy();
    expect(screen.getByText(/Ada Teacher \(@ada\)/)).toBeTruthy();
    expect(screen.getByText("workspace-1")).toBeTruthy();
    expect(screen.getByText("2026-08-26 16:00:00 UTC")).toBeTruthy();
    expect(screen.getByText(/separate from Student Work History/)).toBeTruthy();
  });
});
