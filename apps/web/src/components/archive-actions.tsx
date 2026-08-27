import { api } from "@/lib/convex-api";
import { Button } from "@enkode.app/ui/components/button";
import { useMutation } from "convex/react";
import { useState } from "react";

import { messageFrom } from "@/lib/error-message";

type Target = "assignment" | "material" | "course" | "classroom";

export default function ArchiveActions({ id, target }: { id: string; target: Target }) {
  const archiveAssignment = useMutation(api.archive.archiveAssignment);
  const archiveMaterial = useMutation(api.archive.archiveMaterial);
  const archiveCourse = useMutation(api.archive.archiveCourse);
  const archiveClassroom = useMutation(api.archive.archiveClassroom);
  const deleteAssignment = useMutation(api.archive.deleteAssignmentDraft);
  const deleteMaterial = useMutation(api.archive.deleteMaterialDraft);
  const deleteCourse = useMutation(api.archive.deleteCourseDraft);
  const deleteClassroom = useMutation(api.archive.deleteClassroomDraft);
  const operations = {
    assignment: {
      archive: () => archiveAssignment({ assignmentId: id }),
      remove: () => deleteAssignment({ assignmentId: id }),
    },
    material: {
      archive: () => archiveMaterial({ materialId: id }),
      remove: () => deleteMaterial({ materialId: id }),
    },
    course: {
      archive: () => archiveCourse({ courseId: id }),
      remove: () => deleteCourse({ courseId: id }),
    },
    classroom: {
      archive: () => archiveClassroom({ classroomId: id }),
      remove: () => deleteClassroom({ classroomId: id }),
    },
  } satisfies Record<Target, { archive: () => Promise<unknown>; remove: () => Promise<unknown> }>;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function archive() {
    setBusy(true);
    setError(undefined);
    try {
      await operations[target].archive();
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
      await operations[target].remove();
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
