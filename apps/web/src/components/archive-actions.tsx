import { api } from "@enkode.app/backend/convex/_generated/api";
import { Button } from "@enkode.app/ui/components/button";
import { useMutation } from "convex/react";
import { useState } from "react";

type Target = "assignment" | "material" | "course" | "classroom";

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : "Could not update this item";
}

export default function ArchiveActions({ id, target }: { id: string; target: Target }) {
  const archiveAssignment = useMutation(api.archive.archiveAssignment);
  const archiveMaterial = useMutation(api.archive.archiveMaterial);
  const archiveCourse = useMutation(api.archive.archiveCourse);
  const archiveClassroom = useMutation(api.archive.archiveClassroom);
  const deleteAssignment = useMutation(api.archive.deleteAssignmentDraft);
  const deleteMaterial = useMutation(api.archive.deleteMaterialDraft);
  const deleteCourse = useMutation(api.archive.deleteCourseDraft);
  const deleteClassroom = useMutation(api.archive.deleteClassroomDraft);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function archive() {
    setBusy(true);
    setError(undefined);
    try {
      if (target === "assignment") await archiveAssignment({ assignmentId: id });
      else if (target === "material") await archiveMaterial({ materialId: id });
      else if (target === "course") await archiveCourse({ courseId: id });
      else await archiveClassroom({ classroomId: id });
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusy(false);
    }
  }

  async function permanentlyDelete() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      if (target === "assignment") await deleteAssignment({ assignmentId: id });
      else if (target === "material") await deleteMaterial({ materialId: id });
      else if (target === "course") await deleteCourse({ courseId: id });
      else await deleteClassroom({ classroomId: id });
    } catch (caught) {
      setError(messageFrom(caught));
      setConfirmingDelete(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={archive}>
        Archive
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={permanentlyDelete}>
        {confirmingDelete ? "Confirm permanent deletion" : "Delete draft"}
      </Button>
      {confirmingDelete ? (
        <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
          Cancel
        </Button>
      ) : null}
      {error ? <p className="text-destructive basis-full text-right text-sm">{error}</p> : null}
    </div>
  );
}
