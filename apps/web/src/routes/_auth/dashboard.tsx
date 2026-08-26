import { api } from "@enkode.app/backend/convex/_generated/api";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";

import StudentManagement from "@/components/student-management";

export const Route = createFileRoute("/_auth/dashboard")({
  component: DashboardContent,
});

function DashboardContent() {
  const currentUser = useQuery(api.users.current);

  if (!currentUser) {
    return <div className="p-6">Loading your organization…</div>;
  }

  return (
    <main className="mx-auto w-full max-w-5xl p-6">
      <p className="text-muted-foreground text-sm">{currentUser.organization.name}</p>
      <h1 className="mt-1 text-3xl font-semibold">Welcome, {currentUser.displayName}</h1>
      <p className="text-muted-foreground mt-2 capitalize">{currentUser.role}</p>

      <section className="mt-8 rounded-lg border p-6">
        <h2 className="font-medium">Your Enkode workspace is ready</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Courses and classrooms assigned to you will appear here.
        </p>
      </section>
      {currentUser.role === "teacher" ? <StudentManagement /> : null}
    </main>
  );
}
