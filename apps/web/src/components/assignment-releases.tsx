import { api } from "@enkode.app/backend/convex/_generated/api";
import { Button } from "@enkode.app/ui/components/button";
import { Input } from "@enkode.app/ui/components/input";
import { Link } from "@tanstack/react-router";
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
  latestVersion: number;
  points: number;
  publicationStatus: "draft" | "scheduled" | "published";
  scheduledFor?: number;
  publishedAt?: number;
  submissionLimit?: number;
  deadlinePolicy: DeadlinePolicy;
  deadlineAt?: number;
};
type DeadlinePolicy = "no_deadline" | "accept_late" | "hard_close";
type Enrollment = { studentId: string; displayName: string; status: "active" | "ended" };

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
  const scheduleRelease = useMutation(api.assignmentReleases.schedule);
  const cancelSchedule = useMutation(api.assignmentReleases.cancelSchedule);
  const publishRelease = useMutation(api.assignmentReleases.publishNow);
  const [publicationMode, setPublicationMode] = useState<"immediate" | "draft" | "scheduled">(
    "immediate",
  );
  const [deadlineMode, setDeadlineMode] = useState<DeadlinePolicy>("no_deadline");
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
        publication:
          publicationMode === "scheduled"
            ? {
                mode: "scheduled",
                scheduledFor: new Date(String(form.get("scheduledFor"))).getTime(),
              }
            : publicationMode,
        deadlinePolicy: deadlineMode,
        deadlineAt:
          deadlineMode === "no_deadline"
            ? undefined
            : new Date(String(form.get("deadlineAt"))).getTime(),
        submissionLimit: form.get("submissionLimit")
          ? Number(form.get("submissionLimit"))
          : undefined,
      });
      event.currentTarget.reset();
      setPublicationMode("immediate");
      setDeadlineMode("no_deadline");
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setSaving(false);
    }
  }

  async function schedule(event: FormEvent<HTMLFormElement>, assignmentReleaseId: string) {
    event.preventDefault();
    setError(undefined);
    const form = new FormData(event.currentTarget);
    try {
      await scheduleRelease({
        assignmentReleaseId,
        scheduledFor: new Date(String(form.get("scheduledFor"))).getTime(),
      });
      event.currentTarget.reset();
    } catch (caught) {
      setError(messageFrom(caught));
    }
  }

  async function cancel(assignmentReleaseId: string) {
    setError(undefined);
    try {
      await cancelSchedule({ assignmentReleaseId });
    } catch (caught) {
      setError(messageFrom(caught));
    }
  }

  async function publishNow(assignmentReleaseId: string) {
    setError(undefined);
    try {
      await publishRelease({ assignmentReleaseId });
    } catch (caught) {
      setError(messageFrom(caught));
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
          <form className="flex max-w-2xl flex-col gap-3" onSubmit={release}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
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
              <label className="flex flex-col gap-1.5 text-base sm:text-sm">
                Publication
                <select
                  value={publicationMode}
                  onChange={(event) =>
                    setPublicationMode(event.target.value as typeof publicationMode)
                  }
                  className="border-input bg-background h-10 min-w-36 border px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 sm:h-8 sm:text-xs"
                >
                  <option value="immediate">Publish now</option>
                  <option value="draft">Save as draft</option>
                  <option value="scheduled">Schedule</option>
                </select>
              </label>
            </div>
            {publicationMode === "scheduled" ? (
              <label className="flex max-w-xs flex-col gap-1.5 text-base sm:text-sm">
                Publish date and time
                <Input
                  name="scheduledFor"
                  type="datetime-local"
                  required
                  className="max-sm:h-10 max-sm:text-base"
                />
                <span className="text-muted-foreground text-xs">
                  Uses your device timezone:{" "}
                  <span suppressHydrationWarning>
                    {Intl.DateTimeFormat().resolvedOptions().timeZone}
                  </span>
                </span>
              </label>
            ) : null}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="flex flex-col gap-1.5 text-base sm:text-sm">
                Deadline policy
                <select
                  value={deadlineMode}
                  onChange={(event) => setDeadlineMode(event.target.value as DeadlinePolicy)}
                  className="border-input bg-background h-10 border px-2.5 text-base sm:h-8 sm:text-xs"
                >
                  <option value="no_deadline">No Deadline</option>
                  <option value="accept_late">Accept and mark late</option>
                  <option value="hard_close">Hard close</option>
                </select>
              </label>
              {deadlineMode !== "no_deadline" ? (
                <label className="flex flex-col gap-1.5 text-base sm:text-sm">
                  Deadline
                  <Input name="deadlineAt" type="datetime-local" required />
                </label>
              ) : null}
              <label className="flex flex-col gap-1.5 text-base sm:text-sm">
                Attempt limit
                <Input name="submissionLimit" type="number" min="1" placeholder="Unlimited" />
              </label>
            </div>
            <Button type="submit" className="self-start" disabled={saving || !available?.length}>
              {saving
                ? "Saving…"
                : publicationMode === "immediate"
                  ? "Release now"
                  : publicationMode === "draft"
                    ? "Save draft"
                    : "Schedule release"}
            </Button>
          </form>
          <p className="text-muted-foreground text-base sm:text-sm">
            Releases allow unlimited submissions whether published now or scheduled for later.
          </p>
          {releases?.length === 0 ? (
            <p className="text-muted-foreground text-base sm:text-sm">
              No Assignments released to this Classroom yet.
            </p>
          ) : (
            <ol className="divide-y divide-foreground/10 border-y border-foreground/10">
              {releases?.map((release, index) => (
                <li className="flex flex-col gap-3 py-4" key={release._id}>
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {index + 1}. {release.assignmentTitle}
                      </p>
                      <p className="text-muted-foreground text-base sm:text-sm">
                        Version {release.version} · {release.points} points ·{" "}
                        {release.publicationStatus === "published"
                          ? "Published"
                          : release.publicationStatus === "draft"
                            ? "Draft"
                            : `Scheduled for ${new Date(release.scheduledFor!).toLocaleString([], { timeZoneName: "short" })}`}{" "}
                        ·{" "}
                        {release.submissionLimit === undefined
                          ? "Unlimited submissions"
                          : `${release.submissionLimit} submissions`}{" "}
                        ·{" "}
                        {release.deadlineAt === undefined
                          ? "No Deadline"
                          : `${release.deadlinePolicy === "hard_close" ? "Hard close" : "Late submissions accepted"} ${new Date(release.deadlineAt).toLocaleString([], { timeZoneName: "short" })}`}
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
                  </div>
                  {release.publicationStatus !== "published" ? (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                      <form
                        className="flex flex-col gap-2 sm:flex-row sm:items-end"
                        onSubmit={(event) => void schedule(event, release._id)}
                      >
                        <label className="flex flex-col gap-1 text-sm">
                          {release.publicationStatus === "scheduled"
                            ? "New publish time"
                            : "Publish time"}
                          <Input
                            name="scheduledFor"
                            type="datetime-local"
                            required
                            className="max-sm:h-10 max-sm:text-base"
                          />
                        </label>
                        <Button type="submit" size="sm" variant="outline">
                          {release.publicationStatus === "scheduled" ? "Reschedule" : "Schedule"}
                        </Button>
                      </form>
                      <div className="flex gap-2">
                        {release.publicationStatus === "scheduled" ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => void cancel(release._id)}
                          >
                            Cancel schedule
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => void publishNow(release._id)}
                        >
                          Publish now
                        </Button>
                      </div>
                      <p className="text-muted-foreground text-xs sm:pb-1">
                        Times use{" "}
                        <span suppressHydrationWarning>
                          {Intl.DateTimeFormat().resolvedOptions().timeZone}
                        </span>
                        .
                      </p>
                    </div>
                  ) : null}
                  <VersionAdoption release={release} versions={versions ?? []} />
                  <ReleasePolicyEditor release={release} classroomId={selectedClassroomId} />
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

type VersionPreview = {
  version: number;
  instructions: string;
  runtimeVersion: string;
  entrypoint: string;
  evaluationTests: { name: string; visibility: "public" | "hidden"; weight: number }[];
};
type AdoptionPreview = {
  fromVersion: VersionPreview;
  toVersion: VersionPreview;
  changedStarterFiles: {
    path: string;
    kind: "added" | "modified" | "removed";
    previousContent?: string;
    incomingContent?: string;
  }[];
};

function VersionAdoption({ release, versions }: { release: Release; versions: VersionOption[] }) {
  const newer = versions.filter(
    (version) => version.assignmentId === release.assignmentId && version.version > release.version,
  );
  const [targetId, setTargetId] = useState("");
  const preview = useQuery(
    api.assignmentReleases.previewAdoption,
    targetId ? { assignmentReleaseId: release._id, assignmentVersionId: targetId } : "skip",
  ) as AdoptionPreview | undefined;
  const adopt = useMutation(api.assignmentReleases.adoptVersion);
  const [adopting, setAdopting] = useState(false);
  const [error, setError] = useState<string>();

  if (newer.length === 0) return null;
  async function adoptPreviewed() {
    if (!targetId || !preview) return;
    setAdopting(true);
    setError(undefined);
    try {
      await adopt({ assignmentReleaseId: release._id, assignmentVersionId: targetId });
      setTargetId("");
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setAdopting(false);
    }
  }

  return (
    <details className="border-t border-foreground/10 pt-3">
      <summary className="cursor-pointer text-sm font-medium">
        Preview a newer Assignment Version
      </summary>
      <div className="mt-3 flex max-w-2xl flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Newer version
          <select
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            className="border-input bg-background h-8 max-w-sm border px-2.5 text-xs"
          >
            <option value="">Choose a version to preview</option>
            {newer.map((version) => (
              <option value={version.assignmentVersionId} key={version.assignmentVersionId}>
                Version {version.version} · Python {version.runtimeVersion}
              </option>
            ))}
          </select>
        </label>
        {targetId && !preview ? (
          <p className="text-sm text-muted-foreground">Loading preview…</p>
        ) : null}
        {preview ? (
          <div className="border border-foreground/10 bg-muted/20 p-3 text-sm">
            <p className="font-medium">
              Version {preview.fromVersion.version} → Version {preview.toVersion.version}
            </p>
            <ul className="mt-2 grid gap-1 text-muted-foreground">
              <li>
                Instructions:{" "}
                {preview.fromVersion.instructions === preview.toVersion.instructions
                  ? "unchanged"
                  : "changed"}
              </li>
              <li>
                Runtime: {preview.fromVersion.runtimeVersion} → {preview.toVersion.runtimeVersion}
              </li>
              <li>
                Entrypoint: {preview.fromVersion.entrypoint} → {preview.toVersion.entrypoint}
              </li>
              <li>
                Evaluation Tests: {preview.fromVersion.evaluationTests.length} →{" "}
                {preview.toVersion.evaluationTests.length}
              </li>
            </ul>
            {preview.fromVersion.instructions !== preview.toVersion.instructions ? (
              <details className="mt-3">
                <summary className="cursor-pointer font-medium">Preview new instructions</summary>
                <p className="mt-2 whitespace-pre-wrap border border-foreground/10 bg-background p-3 text-muted-foreground">
                  {preview.toVersion.instructions}
                </p>
              </details>
            ) : null}
            <details className="mt-3">
              <summary className="cursor-pointer font-medium">Preview new Evaluation Tests</summary>
              <ul className="mt-2 grid gap-1 text-muted-foreground">
                {preview.toVersion.evaluationTests.map((test, index) => (
                  <li key={`${test.name}-${index}`}>
                    {test.name} · {test.visibility} · {test.weight} points
                  </li>
                ))}
              </ul>
            </details>
            {preview.changedStarterFiles.length ? (
              <div className="mt-3">
                <p className="font-medium">Starter files requiring each Student's decision</p>
                <ul className="mt-1 text-muted-foreground">
                  {preview.changedStarterFiles.map((file) => (
                    <li key={file.path}>
                      <details>
                        <summary className="cursor-pointer">
                          {file.path} · {file.kind}
                        </summary>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <pre className="overflow-x-auto border border-foreground/10 bg-background p-2 text-xs">
                            {file.previousContent ?? "File did not exist"}
                          </pre>
                          <pre className="overflow-x-auto border border-foreground/10 bg-background p-2 text-xs">
                            {file.incomingContent ?? "File will be removed"}
                          </pre>
                        </div>
                      </details>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="mt-3 text-muted-foreground">
                Starter files are unchanged; existing Workspaces can move without file replacement.
              </p>
            )}
            <Button
              type="button"
              size="sm"
              className="mt-3"
              disabled={adopting}
              onClick={() => void adoptPreviewed()}
            >
              {adopting ? "Adopting…" : `Adopt Version ${preview.toVersion.version}`}
            </Button>
          </div>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </details>
  );
}

type StudentRelease = Release & {
  classroomName: string;
  runtimeVersion: string;
  effectiveDeadline: { deadlineAt?: number };
  submissionEligibility: { canSubmit: boolean; reason?: string; remainingAttempts?: number };
  deadlineFacts: { missing: boolean; late: boolean };
};

export function StudentAssignmentReleases() {
  const releases = useQuery(api.assignmentReleases.listMine) as StudentRelease[] | undefined;

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
              <Link
                to="/assignment-releases/$assignmentReleaseId"
                params={{ assignmentReleaseId: release._id }}
                className="block w-full text-left hover:text-primary"
              >
                <span className="block font-medium">{release.assignmentTitle}</span>
                <span className="text-muted-foreground block text-base sm:text-sm">
                  {release.classroomName} · {release.points} points · Version {release.version}
                </span>
                <span className="text-muted-foreground block text-sm">
                  {release.effectiveDeadline.deadlineAt === undefined
                    ? "No Deadline"
                    : `Due ${new Date(release.effectiveDeadline.deadlineAt).toLocaleString([], { timeZoneName: "short" })}`}
                  {release.submissionEligibility.remainingAttempts === undefined
                    ? " · Unlimited attempts"
                    : ` · ${release.submissionEligibility.remainingAttempts} attempts remaining`}
                  {release.deadlineFacts.missing ? " · Missing" : ""}
                  {release.deadlineFacts.late ? " · Late" : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReleasePolicyEditor({ release, classroomId }: { release: Release; classroomId: string }) {
  const enrollments = useQuery(api.enrollments.listForClassroom, { classroomId }) as
    | Enrollment[]
    | undefined;
  const exceptions = useQuery(api.assignmentReleases.listDeadlineExceptions, {
    assignmentReleaseId: release._id,
  }) as
    | {
        _id: string;
        studentId: string;
        studentName: string;
        deadlinePolicy: DeadlinePolicy;
        deadlineAt?: number;
      }[]
    | undefined;
  const configure = useMutation(api.assignmentReleases.configureSubmissionPolicy);
  const setException = useMutation(api.assignmentReleases.setDeadlineException);
  const removeException = useMutation(api.assignmentReleases.removeDeadlineException);
  const [policy, setPolicy] = useState(release.deadlinePolicy);
  const [exceptionPolicy, setExceptionPolicy] = useState<DeadlinePolicy>("accept_late");

  async function savePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await configure({
      assignmentReleaseId: release._id,
      deadlinePolicy: policy,
      deadlineAt:
        policy === "no_deadline" ? undefined : new Date(String(form.get("deadlineAt"))).getTime(),
      submissionLimit: form.get("submissionLimit")
        ? Number(form.get("submissionLimit"))
        : undefined,
    });
  }

  async function saveException(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await setException({
      assignmentReleaseId: release._id,
      studentId: String(form.get("studentId")),
      deadlinePolicy: exceptionPolicy,
      deadlineAt:
        exceptionPolicy === "no_deadline"
          ? undefined
          : new Date(String(form.get("deadlineAt"))).getTime(),
    });
    event.currentTarget.reset();
  }

  return (
    <details className="border-t border-foreground/10 pt-3">
      <summary className="cursor-pointer text-sm font-medium">
        Deadline and attempt settings
      </summary>
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <form className="grid gap-2" onSubmit={(event) => void savePolicy(event)}>
          <select
            value={policy}
            onChange={(event) => setPolicy(event.target.value as DeadlinePolicy)}
            className="border-input bg-background h-8 border px-2 text-xs"
          >
            <option value="no_deadline">No Deadline</option>
            <option value="accept_late">Accept and mark late</option>
            <option value="hard_close">Hard close</option>
          </select>
          {policy !== "no_deadline" ? (
            <Input name="deadlineAt" type="datetime-local" required />
          ) : null}
          <Input
            name="submissionLimit"
            type="number"
            min="1"
            defaultValue={release.submissionLimit}
            placeholder="Unlimited attempts"
          />
          <Button type="submit" size="sm" variant="outline" className="justify-self-start">
            Save release policy
          </Button>
        </form>
        <form className="grid gap-2" onSubmit={(event) => void saveException(event)}>
          <select
            name="studentId"
            required
            className="border-input bg-background h-8 border px-2 text-xs"
          >
            <option value="">Choose a Student</option>
            {enrollments
              ?.filter(({ status }) => status === "active")
              .map((enrollment) => (
                <option key={enrollment.studentId} value={enrollment.studentId}>
                  {enrollment.displayName}
                </option>
              ))}
          </select>
          <select
            value={exceptionPolicy}
            onChange={(event) => setExceptionPolicy(event.target.value as DeadlinePolicy)}
            className="border-input bg-background h-8 border px-2 text-xs"
          >
            <option value="no_deadline">No Deadline</option>
            <option value="accept_late">Accept and mark late</option>
            <option value="hard_close">Hard close</option>
          </select>
          {exceptionPolicy !== "no_deadline" ? (
            <Input name="deadlineAt" type="datetime-local" required />
          ) : null}
          <Button type="submit" size="sm" variant="outline" className="justify-self-start">
            Save Deadline Exception
          </Button>
        </form>
      </div>
      {exceptions?.length ? (
        <ul className="mt-3 grid gap-1 text-sm text-muted-foreground">
          {exceptions.map((exception) => (
            <li key={exception._id} className="flex items-center justify-between gap-3">
              <span>
                {exception.studentName} · {exception.deadlinePolicy.replaceAll("_", " ")}
                {exception.deadlineAt
                  ? ` · ${new Date(exception.deadlineAt).toLocaleString()}`
                  : ""}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() =>
                  void removeException({
                    assignmentReleaseId: release._id,
                    studentId: exception.studentId,
                  })
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}
