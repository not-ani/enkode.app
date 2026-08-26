import { api } from "@enkode.app/backend/convex/_generated/api";
import { Button } from "@enkode.app/ui/components/button";
import { Input } from "@enkode.app/ui/components/input";
import { Label } from "@enkode.app/ui/components/label";
import { useAction, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";

const emptyStudent = { displayName: "", email: "", password: "", username: "" };

export default function StudentManagement() {
  const students = useQuery(api.students.list);
  const provision = useAction(api.students.provision);
  const resetPassword = useAction(api.students.resetPassword);
  const [student, setStudent] = useState(emptyStudent);
  const [reset, setReset] = useState<{ password: string; studentId?: string }>({ password: "" });
  const [isSaving, setIsSaving] = useState(false);

  async function handleProvision(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    try {
      await provision({
        displayName: student.displayName,
        email: student.email || undefined,
        password: student.password,
        username: student.username,
      });
      setStudent(emptyStudent);
      toast.success("Student provisioned");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not provision Student");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reset.studentId) return;
    setIsSaving(true);
    try {
      await resetPassword({ password: reset.password, studentId: reset.studentId });
      setReset({ password: "" });
      toast.success("Student password reset");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not reset password");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="mt-8 rounded-lg border p-6">
      <h2 className="text-lg font-medium">Students</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Provision a Student in this organization. Passwords can be replaced, never viewed.
      </p>

      <form className="mt-5 grid gap-4 sm:grid-cols-2" onSubmit={handleProvision}>
        <div className="space-y-2">
          <Label htmlFor="student-name">Name</Label>
          <Input
            id="student-name"
            required
            value={student.displayName}
            onChange={(event) => setStudent({ ...student, displayName: event.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="student-username">Username</Label>
          <Input
            id="student-username"
            required
            autoComplete="off"
            value={student.username}
            onChange={(event) => setStudent({ ...student, username: event.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="student-email">Email (optional)</Label>
          <Input
            id="student-email"
            type="email"
            value={student.email}
            onChange={(event) => setStudent({ ...student, email: event.target.value })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="student-password">Initial password</Label>
          <Input
            id="student-password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={student.password}
            onChange={(event) => setStudent({ ...student, password: event.target.value })}
          />
        </div>
        <Button className="sm:col-span-2 sm:w-fit" disabled={isSaving} type="submit">
          {isSaving ? "Provisioning…" : "Provision Student"}
        </Button>
      </form>

      <div className="mt-8 space-y-3">
        {students?.map(
          (entry: { id: string; displayName: string; username: string; email?: string }) => (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              key={entry.id}
            >
              <div>
                <p className="font-medium">{entry.displayName}</p>
                <p className="text-muted-foreground text-sm">
                  {entry.username}
                  {entry.email ? ` · ${entry.email}` : ""}
                </p>
              </div>
              {reset.studentId === entry.id ? (
                <form className="flex flex-wrap gap-2" onSubmit={handleReset}>
                  <Input
                    aria-label={`New password for ${entry.displayName}`}
                    type="password"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    placeholder="New password"
                    value={reset.password}
                    onChange={(event) => setReset({ ...reset, password: event.target.value })}
                  />
                  <Button disabled={isSaving} type="submit">
                    Reset
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setReset({ password: "" })}
                  >
                    Cancel
                  </Button>
                </form>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setReset({ password: "", studentId: entry.id })}
                >
                  Reset password
                </Button>
              )}
            </div>
          ),
        )}
        {students?.length === 0 ? (
          <p className="text-muted-foreground text-sm">No Students provisioned yet.</p>
        ) : null}
      </div>
    </section>
  );
}
