import { api } from "@/lib/convex-api";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";

export const Route = createFileRoute("/_auth/material-releases/$materialReleaseId")({
  component: MaterialReleaseRoute,
});

function MaterialReleaseRoute() {
  const { materialReleaseId } = Route.useParams();
  const material = useQuery(api.materialReleases.open, { materialReleaseId });

  if (!material) {
    return <main className="p-6 text-sm text-muted-foreground">Opening Material…</main>;
  }

  return (
    <main className="isolate overflow-y-auto p-6 sm:p-8">
      <article className="mx-auto max-w-3xl">
        <Link to="/dashboard" className="text-muted-foreground text-sm hover:text-foreground">
          ← Dashboard
        </Link>
        {material.classroomName ? (
          <p className="text-muted-foreground mt-6 text-sm">{material.classroomName}</p>
        ) : null}
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{material.materialTitle}</h1>
        {material.kind === "rich_text" ? (
          <div className="mt-8 whitespace-pre-wrap border-y border-foreground/10 py-6 text-sm leading-7">
            {material.richText}
          </div>
        ) : material.kind === "external_link" && material.externalUrl ? (
          <a
            className="mt-8 inline-flex min-h-10 items-center border border-foreground/15 px-4 text-sm font-medium hover:bg-muted"
            href={material.externalUrl}
            rel="noreferrer"
            target="_blank"
          >
            Open external Material
          </a>
        ) : material.attachment ? (
          <section className="mt-8 border-y border-foreground/10 py-6">
            <h2 className="font-medium">{material.attachment.filename}</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              {material.attachment.contentType} · {material.attachment.byteSize.toLocaleString()}{" "}
              bytes
            </p>
          </section>
        ) : null}
      </article>
    </main>
  );
}
