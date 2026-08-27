import { api } from "@/lib/convex-api";
import { Button } from "@enkode.app/ui/components/button";
import { Input } from "@enkode.app/ui/components/input";
import { Textarea } from "@enkode.app/ui/components/textarea";
import { useAction, useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";

import ArchiveActions from "./archive-actions";
import { messageFrom } from "@/lib/error-message";

type MaterialKind = "rich_text" | "external_link" | "file";

function contentFrom(form: FormData, kind: MaterialKind, attachmentId?: string) {
  if (kind === "rich_text") {
    return { kind, richText: String(form.get("richText")) } as const;
  }
  if (kind === "external_link") {
    return { kind, externalUrl: String(form.get("externalUrl")) } as const;
  }
  if (!attachmentId) throw new Error("Choose a file to upload");
  return {
    kind,
    attachmentId,
  } as const;
}

export default function MaterialAuthoring({ courseId }: { courseId: string }) {
  const materials = useQuery(api.materials.listByCourse, { courseId });
  const createMaterial = useMutation(api.materials.create);
  const createVersion = useMutation(api.materials.createVersion);
  const uploadAttachment = useAction(api.materialUpload.upload);
  const [kind, setKind] = useState<MaterialKind>("rich_text");
  const [versionOf, setVersionOf] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    const form = new FormData(event.currentTarget);
    try {
      const file = form.get("attachment");
      const uploaded =
        kind === "file" && file instanceof File
          ? await uploadAttachment({
              courseId,
              filename: file.name,
              contentType: file.type || "application/octet-stream",
              bytes: await file.arrayBuffer(),
            })
          : undefined;
      if (kind === "file" && !uploaded) throw new Error("Choose a file to upload");
      const content = contentFrom(form, kind, uploaded?.attachmentId);
      if (versionOf) await createVersion({ materialId: versionOf, content });
      else await createMaterial({ courseId, title: String(form.get("title")), content });
      event.currentTarget.reset();
      setKind("rich_text");
      setVersionOf("");
    } catch (caught) {
      setError(messageFrom(caught, "Could not save this Material"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="border-t border-foreground/10 pt-4">
      <summary className="cursor-pointer font-medium text-base sm:text-sm">
        Author Materials
      </summary>
      {materials?.length ? (
        <ul className="mt-4 flex flex-col gap-2" role="list">
          {materials.map((material) => (
            <li className="flex items-center justify-between gap-3 text-sm" key={material._id}>
              <span>
                {material.title} · Version {material.latestVersion}
              </span>
              <ArchiveActions id={material._id} target="material" />
            </li>
          ))}
        </ul>
      ) : null}
      <form className="mt-4 flex flex-col gap-3" onSubmit={save}>
        <label className="flex flex-col gap-1 text-base sm:text-sm">
          Save as
          <select
            value={versionOf}
            onChange={(event) => setVersionOf(event.target.value)}
            className="border-input bg-background h-10 border px-2.5 text-base sm:h-8 sm:text-xs"
          >
            <option value="">New Material</option>
            {materials?.map((material) => (
              <option value={material._id} key={material._id}>
                New Version of {material.title} (currently Version {material.latestVersion})
              </option>
            ))}
          </select>
        </label>
        {!versionOf ? (
          <label className="flex flex-col gap-1 text-base sm:text-sm">
            Material title
            <Input name="title" required />
          </label>
        ) : null}
        <label className="flex flex-col gap-1 text-base sm:text-sm">
          Material type
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as MaterialKind)}
            className="border-input bg-background h-10 border px-2.5 text-base sm:h-8 sm:text-xs"
          >
            <option value="rich_text">Rich-text page</option>
            <option value="external_link">External link</option>
            <option value="file">Attached file</option>
          </select>
        </label>
        {kind === "rich_text" ? (
          <label className="flex flex-col gap-1 text-base sm:text-sm">
            Page content
            <Textarea name="richText" required placeholder="Markdown-rich course material" />
          </label>
        ) : kind === "external_link" ? (
          <label className="flex flex-col gap-1 text-base sm:text-sm">
            HTTP or HTTPS link
            <Input name="externalUrl" type="url" required placeholder="https://…" />
          </label>
        ) : (
          <label className="flex flex-col gap-1 text-base sm:text-sm">
            Attached file
            <Input name="attachment" type="file" required />
            <span className="text-xs text-muted-foreground">
              Enkode uploads and verifies the file before creating the immutable Version.
            </span>
          </label>
        )}
        {error ? <p className="text-destructive text-base sm:text-sm">{error}</p> : null}
        <Button type="submit" size="sm" className="self-start" disabled={saving}>
          {saving ? "Saving…" : versionOf ? "Create immutable Version" : "Create Material"}
        </Button>
      </form>
    </details>
  );
}
