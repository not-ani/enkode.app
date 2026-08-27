import { api } from "@/lib/convex-api";
import { Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";

export default function WorkHistoryList({ role }: { role: "student" | "teacher" }) {
  const histories = useQuery(api.workHistoryReplay.listAccessible);
  return (
    <section className="flex flex-col gap-4 border-t border-foreground/10 pt-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">
          {role === "student" ? "Your Work History" : "Student Work History"}
        </h2>
        <p className="text-sm text-muted-foreground">
          Replay committed Workspace changes and their observed Edit Origins.
        </p>
      </div>
      {!histories ? (
        <p className="text-sm text-muted-foreground">Loading Work History…</p>
      ) : histories.length === 0 ? (
        <p className="text-sm text-muted-foreground">No committed Work History is available.</p>
      ) : (
        <ul role="list" className="divide-y divide-foreground/10 border-y border-foreground/10">
          {histories.map((history) => (
            <li className="flex items-center justify-between gap-4 py-4" key={history.workspaceId}>
              <div className="min-w-0">
                <p className="truncate font-medium">{history.assignmentTitle}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {history.classroomName}
                  {role === "teacher"
                    ? ` · ${history.studentName} (@${history.studentUsername})`
                    : ""}
                </p>
              </div>
              <Link
                to="/work-history/$workspaceId"
                params={{ workspaceId: history.workspaceId }}
                className="shrink-0 text-sm font-medium underline-offset-4 hover:underline"
              >
                Replay {history.committedThrough} events
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
