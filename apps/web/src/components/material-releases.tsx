import { api } from "@/lib/convex-api";
import { Button } from "@enkode.app/ui/components/button";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState, type FormEvent } from "react";

import { messageFrom } from "@/lib/error-message";

import {
  PublicationControl,
  publicationFromForm,
  type PublicationMode,
} from "./publication-control";

type Classroom = FunctionReturnType<typeof api.classrooms.listMine>[number];
export default function MaterialReleases({ classrooms }: { classrooms: Classroom[] }) {
  const [classroomId, setClassroomId] = useState(classrooms[0]?._id ?? "");
  const selectedClassroomId = classrooms.some(({ _id }) => _id === classroomId)
    ? classroomId
    : (classrooms[0]?._id ?? "");
  const queryArgs = selectedClassroomId ? { classroomId: selectedClassroomId } : "skip";
  const versions = useQuery(api.materialReleases.availableVersions, queryArgs);
  const releases = useQuery(api.materialReleases.listForClassroom, queryArgs);
  const createRelease = useMutation(api.materialReleases.create);
  const adoptVersion = useMutation(api.materialReleases.adoptVersion);
  const moveRelease = useMutation(api.materialReleases.move);
  const publishRelease = useMutation(api.materialReleases.publishNow);
  const [publicationMode, setPublicationMode] = useState<PublicationMode>("immediate");
  const [error, setError] = useState<string>();

  const available = versions?.filter(
    (version) => !releases?.some((release) => release.materialId === version.materialId),
  );

  async function release(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const form = new FormData(event.currentTarget);
    try {
      await createRelease({
        classroomId: selectedClassroomId,
        materialVersionId: String(form.get("materialVersionId")),
        publication: publicationFromForm(publicationMode, form),
      });
      event.currentTarget.reset();
      setPublicationMode("immediate");
    } catch (caught) {
      setError(messageFrom(caught));
    }
  }

  async function adopt(event: FormEvent<HTMLFormElement>, materialReleaseId: string) {
    event.preventDefault();
    setError(undefined);
    try {
      await adoptVersion({
        materialReleaseId,
        materialVersionId: String(new FormData(event.currentTarget).get("materialVersionId")),
      });
    } catch (caught) {
      setError(messageFrom(caught));
    }
  }

  async function change(operation: () => Promise<unknown>) {
    setError(undefined);
    try {
      await operation();
    } catch (caught) {
      setError(messageFrom(caught));
    }
  }

  return (
    <section className="flex flex-col gap-5 border-t border-foreground/10 pt-8">
      <div>
        <h2 className="text-xl font-semibold">Material Releases</h2>
        <p className="text-muted-foreground text-base sm:text-sm">
          Pin an exact Material Version and choose when Students can see it.
        </p>
      </div>
      {classrooms.length === 0 ? (
        <p className="text-muted-foreground text-base sm:text-sm">
          Create a Classroom before releasing a Material.
        </p>
      ) : (
        <>
          <label className="flex max-w-md flex-col gap-1 text-base sm:text-sm">
            Classroom
            <select
              value={selectedClassroomId}
              onChange={(event) => setClassroomId(event.target.value)}
              className="border-input bg-background h-10 border px-2.5 text-base sm:h-8 sm:text-xs"
            >
              {classrooms.map((classroom) => (
                <option value={classroom._id} key={classroom._id}>
                  {classroom.name} · {classroom.courseName}
                </option>
              ))}
            </select>
          </label>
          <form className="flex max-w-3xl flex-col gap-3" onSubmit={release}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-base sm:text-sm">
                Exact Material Version
                <select
                  name="materialVersionId"
                  required
                  defaultValue=""
                  disabled={!available?.length}
                  className="border-input bg-background h-10 border px-2.5 text-base sm:h-8 sm:text-xs"
                >
                  <option value="">Select a Version</option>
                  {available?.map((version) => (
                    <option value={version.materialVersionId} key={version.materialVersionId}>
                      {version.materialTitle} · Version {version.version} ·{" "}
                      {version.kind.replace("_", " ")}
                    </option>
                  ))}
                </select>
              </label>
              <PublicationControl mode={publicationMode} onChange={setPublicationMode} />
            </div>
            <Button type="submit" size="sm" className="self-start" disabled={!available?.length}>
              Release Material
            </Button>
          </form>
          <ol className="divide-y divide-foreground/10 border-y border-foreground/10">
            {releases?.map((release, index) => {
              const newer = versions?.filter(
                (version) =>
                  version.materialId === release.materialId && version.version > release.version,
              );
              return (
                <li className="flex flex-col gap-3 py-4" key={release._id}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">
                        {index + 1}. {release.materialTitle}
                      </p>
                      <p className="text-muted-foreground text-base sm:text-sm">
                        Version {release.version} · {release.kind.replace("_", " ")} ·{" "}
                        {release.publicationStatus === "scheduled"
                          ? `Scheduled ${new Date(release.scheduledFor!).toISOString()}`
                          : release.publicationStatus}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={index === 0}
                        onClick={() =>
                          void change(() =>
                            moveRelease({ materialReleaseId: release._id, direction: "up" }),
                          )
                        }
                      >
                        Up
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={index === releases.length - 1}
                        onClick={() =>
                          void change(() =>
                            moveRelease({ materialReleaseId: release._id, direction: "down" }),
                          )
                        }
                      >
                        Down
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {release.publicationStatus !== "published" ? (
                      <Button
                        size="sm"
                        onClick={() =>
                          void change(() => publishRelease({ materialReleaseId: release._id }))
                        }
                      >
                        Publish now
                      </Button>
                    ) : null}
                    {newer?.length ? (
                      <form
                        className="flex gap-2"
                        onSubmit={(event) => void adopt(event, release._id)}
                      >
                        <select
                          name="materialVersionId"
                          aria-label={`New Version of ${release.materialTitle}`}
                          className="border-input bg-background h-8 border px-2 text-xs"
                        >
                          {newer.map((version) => (
                            <option
                              key={version.materialVersionId}
                              value={version.materialVersionId}
                            >
                              Version {version.version}
                            </option>
                          ))}
                        </select>
                        <Button type="submit" size="sm" variant="outline">
                          Adopt Version
                        </Button>
                      </form>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
          {error ? <p className="text-destructive text-base sm:text-sm">{error}</p> : null}
        </>
      )}
    </section>
  );
}

type StudentMaterial = FunctionReturnType<typeof api.materialReleases.listMine>[number];

function StudentMaterialItem({ material }: { material: StudentMaterial }) {
  const opened = useQuery(api.materialReleases.open, { materialReleaseId: material._id });
  return (
    <li className="flex flex-col gap-2 py-4">
      <p className="font-medium">{material.materialTitle}</p>
      <p className="text-muted-foreground text-base sm:text-sm">
        {material.classroomName} · Version {material.version} · {material.kind.replace("_", " ")}
      </p>
      {opened?.kind === "rich_text" ? (
        <p className="whitespace-pre-wrap text-base sm:text-sm">{opened.richText}</p>
      ) : opened?.kind === "external_link" ? (
        <a
          className="text-primary underline underline-offset-4"
          href={opened.externalUrl}
          target="_blank"
          rel="noreferrer"
        >
          Open external Material
        </a>
      ) : opened?.kind === "file" && opened.attachment ? (
        <p className="text-base sm:text-sm">
          {opened.attachment.filename} · {opened.attachment.contentType} ·{" "}
          {opened.attachment.byteSize.toLocaleString()} bytes
        </p>
      ) : null}
    </li>
  );
}

export function StudentMaterials() {
  const materials = useQuery(api.materialReleases.listMine);
  return (
    <section className="mt-8 flex max-w-2xl flex-col gap-3">
      <h2 className="text-xl font-semibold">Materials</h2>
      {!materials ? (
        <p className="text-muted-foreground">Loading Materials…</p>
      ) : materials.length === 0 ? (
        <p className="text-muted-foreground">No published Materials are available.</p>
      ) : (
        <ul className="divide-y divide-foreground/10 border-y border-foreground/10">
          {materials.map((material) => (
            <StudentMaterialItem material={material} key={material._id} />
          ))}
        </ul>
      )}
    </section>
  );
}
