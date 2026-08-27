import { api } from "@/lib/convex-api";
import { useQuery } from "convex/react";
import { lazy, Suspense, useState } from "react";

import { languageLabel } from "@/lib/language-intelligence";

import { useTeacherPresence } from "./use-teacher-presence";

const MonacoEditor = lazy(() => import("./workspace-monaco"));

export default function LiveWorkspaceViewer({ workspaceId }: { workspaceId: string }) {
  const { entered, error, sessionId } = useTeacherPresence(workspaceId, "workspace");
  const [activePath, setActivePath] = useState<string>();
  const workspace = useQuery(
    api.liveWorkspaces.watch,
    entered && sessionId ? { workspaceId, sessionId } : "skip",
  );

  if (error) return <p className="p-6 text-destructive">{error}</p>;
  if (!workspace) {
    return <p className="p-6 text-sm text-muted-foreground">Opening live Workspace…</p>;
  }

  const selectedPath = workspace.files.some(({ path }) => path === activePath)
    ? activePath
    : (workspace.files[0]?.path ?? "");
  const selectedFile = workspace.files.find(({ path }) => path === selectedPath);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{workspace.classroomName}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{workspace.assignmentTitle}</h1>
        <p className="text-sm text-muted-foreground">
          Viewing {workspace.studentDisplayName} (@{workspace.studentUsername}) ·{" "}
          {languageLabel(workspace.language)} {workspace.runtimeVersion}
        </p>
      </header>
      <p className="border-y border-foreground/10 py-3 text-sm text-muted-foreground">
        Live view is read-only and follows the Student’s committed saves.
      </p>
      <section className="grid min-h-[36rem] overflow-hidden border border-foreground/10 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="border-b border-foreground/10 bg-muted/30 lg:border-r lg:border-b-0">
          <p className="px-3 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Files
          </p>
          <div
            role="tablist"
            aria-label="Workspace files"
            className="flex overflow-x-auto lg:flex-col"
          >
            {workspace.files.map(({ path }) => (
              <button
                type="button"
                role="tab"
                aria-selected={path === selectedPath}
                className="shrink-0 border-l-2 border-transparent px-3 py-2 text-left font-mono text-sm hover:bg-muted aria-selected:border-primary aria-selected:bg-muted"
                onClick={() => setActivePath(path)}
                key={path}
              >
                {path}
                {path === workspace.entrypoint ? (
                  <span className="sr-only"> (entrypoint)</span>
                ) : null}
              </button>
            ))}
          </div>
        </aside>
        <div className="flex min-w-0 flex-col">
          <div className="flex min-h-12 items-center justify-between border-b border-foreground/10 px-3">
            <p className="truncate font-mono text-sm">{selectedPath}</p>
            <p className="text-xs text-muted-foreground">Read-only</p>
          </div>
          <div className="min-h-0 flex-1">
            <Suspense
              fallback={<div className="p-4 text-sm text-muted-foreground">Loading editor…</div>}
            >
              <MonacoEditor
                height="100%"
                language={workspace.language}
                path={`enkode-live://${workspaceId}/${selectedPath}`}
                value={selectedFile?.content ?? ""}
                options={{
                  automaticLayout: true,
                  minimap: { enabled: false },
                  padding: { top: 12 },
                  readOnly: true,
                  readOnlyMessage: { value: "This live Workspace is read-only." },
                  scrollBeyondLastLine: false,
                  tabSize: 4,
                }}
              />
            </Suspense>
          </div>
        </div>
      </section>
    </div>
  );
}

export function WorkspaceViewers({ workspaceId }: { workspaceId: string }) {
  const viewers = useQuery(api.liveWorkspaces.listViewers, { workspaceId });
  if (!viewers?.length) return null;
  return (
    <p role="status" className="border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
      {viewers
        .map(
          ({ displayName, viewKind }) =>
            `${displayName} (${viewKind === "work_history" ? "Work History" : "Workspace"})`,
        )
        .join(", ")}{" "}
      {viewers.length === 1 ? "is" : "are"} viewing your work.
    </p>
  );
}
