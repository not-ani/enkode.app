import { api } from "@enkode.app/backend/convex/_generated/api";
import { Button } from "@enkode.app/ui/components/button";
import { Input } from "@enkode.app/ui/components/input";
import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";

type Classroom = { _id: string; name: string; courseName: string };
type VersionOption = {
  assignmentId: string;
  assignmentTitle: string;
  assignmentVersionId: string;
  version: number;
  runtimeVersion: string;
};
type Release = {
  _id: string;
  assignmentId: string;
  assignmentTitle: string;
  version: number;
  points: number;
  publishedAt: number;
  submissionLimit?: number;
};

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : "Could not release this Assignment";
}

export default function AssignmentReleases({ classrooms }: { classrooms: Classroom[] }) {
  const [classroomId, setClassroomId] = useState(classrooms[0]?._id ?? "");
  const selectedClassroomId = classrooms.some(({ _id }) => _id === classroomId)
    ? classroomId
    : (classrooms[0]?._id ?? "");
  const queryArgs = selectedClassroomId ? { classroomId: selectedClassroomId } : "skip";
  const versions = useQuery(api.assignmentReleases.availableVersions, queryArgs) as
    | VersionOption[]
    | undefined;
  const releases = useQuery(api.assignmentReleases.listForClassroom, queryArgs) as
    | Release[]
    | undefined;
  const createRelease = useMutation(api.assignmentReleases.create);
  const moveRelease = useMutation(api.assignmentReleases.move);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const available = versions?.filter(
    (version) => !releases?.some((release) => release.assignmentId === version.assignmentId),
  );

  async function release(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    const form = new FormData(event.currentTarget);
    try {
      await createRelease({
        classroomId: selectedClassroomId,
        assignmentVersionId: String(form.get("assignmentVersionId")),
        points: Number(form.get("points")),
      });
      event.currentTarget.reset();
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setSaving(false);
    }
  }

  async function move(assignmentReleaseId: string, direction: "up" | "down") {
    setError(undefined);
    try {
      await moveRelease({ assignmentReleaseId, direction });
    } catch (caught) {
      setError(messageFrom(caught));
    }
  }

  return (
    <section className="flex flex-col gap-5 border-t border-foreground/10 pt-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-balance text-xl font-semibold">Assignment Releases</h2>
        <p className="text-muted-foreground text-pretty text-base sm:text-sm">
          Choose an exact Assignment Version, then set the points and order for this Classroom.
        </p>
      </div>
      {classrooms.length === 0 ? (
        <p className="text-muted-foreground text-base sm:text-sm">
          Create a Classroom before releasing an Assignment.
        </p>
      ) : (
        <>
          <label className="flex max-w-md flex-col gap-1.5 text-base sm:text-sm">
            Classroom
            <select
              value={selectedClassroomId}
              onChange={(event) => setClassroomId(event.target.value)}
              className="border-input bg-background h-10 min-w-0 border px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 sm:h-8 sm:text-xs"
            >
              {classrooms.map((classroom) => (
                <option value={classroom._id} key={classroom._id}>
                  {classroom.name} · {classroom.courseName}
                </option>
              ))}
            </select>
          </label>
          <form
            className="flex max-w-2xl flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={release}
          >
            <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-base sm:text-sm">
              Exact Assignment Version
              <select
                name="assignmentVersionId"
                required
                defaultValue=""
                disabled={!available?.length}
                className="border-input bg-background h-10 min-w-0 border px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 sm:h-8 sm:text-xs"
              >
                <option value="">Select a version</option>
                {available?.map((version) => (
                  <option value={version.assignmentVersionId} key={version.assignmentVersionId}>
                    {version.assignmentTitle} · Version {version.version} · Python{" "}
                    {version.runtimeVersion}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-base sm:text-sm">
              Points
              <Input
                name="points"
                type="number"
                min="0"
                step="any"
                defaultValue="100"
                required
                disabled={!available?.length}
                className="w-28 max-sm:h-10 max-sm:text-base"
              />
            </label>
            <Button type="submit" disabled={saving || !available?.length}>
              {saving ? "Releasing…" : "Release now"}
            </Button>
          </form>
          <p className="text-muted-foreground text-base sm:text-sm">
            New releases are published immediately and allow unlimited submissions.
          </p>
          {releases?.length === 0 ? (
            <p className="text-muted-foreground text-base sm:text-sm">
              No Assignments released to this Classroom yet.
            </p>
          ) : (
            <ol className="divide-y divide-foreground/10 border-y border-foreground/10">
              {releases?.map((release, index) => (
                <li className="flex items-center justify-between gap-4 py-4" key={release._id}>
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {index + 1}. {release.assignmentTitle}
                    </p>
                    <p className="text-muted-foreground text-base sm:text-sm">
                      Version {release.version} · {release.points} points · Published ·{" "}
                      {release.submissionLimit === undefined
                        ? "Unlimited submissions"
                        : `${release.submissionLimit} submissions`}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={index === 0}
                      onClick={() => void move(release._id, "up")}
                    >
                      Move up
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={index === releases.length - 1}
                      onClick={() => void move(release._id, "down")}
                    >
                      Move down
                    </Button>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {error ? <p className="text-destructive text-base sm:text-sm">{error}</p> : null}
        </>
      )}
    </section>
  );
}

type StudentRelease = Release & { classroomName: string; runtimeVersion: string };
type OpenRelease = StudentRelease & {
  instructions: string;
  entrypoint: string;
  starterFiles: { _id: string; path: string }[];
};

export function StudentAssignmentReleases() {
  const releases = useQuery(api.assignmentReleases.listMine) as StudentRelease[] | undefined;
  const [openId, setOpenId] = useState<string>();
  const opened = useQuery(
    api.assignmentReleases.open,
    openId ? { assignmentReleaseId: openId } : "skip",
  ) as OpenRelease | undefined;

  return (
    <section className="mt-8 flex max-w-2xl flex-col gap-3">
      <h2 className="text-xl font-semibold">Your Assignments</h2>
      {!releases ? (
        <p className="text-muted-foreground text-base sm:text-sm">Loading Assignments…</p>
      ) : releases.length === 0 ? (
        <p className="text-muted-foreground text-base sm:text-sm">
          No published Assignment Releases are available.
        </p>
      ) : (
        <ul className="divide-y divide-foreground/10 border-y border-foreground/10">
          {releases.map((release) => (
            <li className="py-4" key={release._id}>
              <button
                type="button"
                className="w-full text-left"
                onClick={() => setOpenId(openId === release._id ? undefined : release._id)}
              >
                <span className="block font-medium">{release.assignmentTitle}</span>
                <span className="text-muted-foreground block text-base sm:text-sm">
                  {release.classroomName} · {release.points} points · Version {release.version}
                </span>
              </button>
              {openId === release._id && opened?._id === release._id ? (
                <div className="bg-muted/50 mt-3 flex flex-col gap-2 p-4 text-base sm:text-sm">
                  <p className="whitespace-pre-wrap">{opened.instructions}</p>
                  <p className="text-muted-foreground">
                    Python {opened.runtimeVersion} · Entrypoint {opened.entrypoint}
                  </p>
                  <p className="text-muted-foreground">
                    Starter files: {opened.starterFiles.map(({ path }) => path).join(", ")}
                  </p>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
