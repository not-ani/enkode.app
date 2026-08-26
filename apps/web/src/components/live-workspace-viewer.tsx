import { api } from "@enkode.app/backend/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { lazy, Suspense, useEffect, useState } from "react";

import type { WorkspaceFile } from "@/lib/workspace-state";

const MonacoEditor = lazy(() => import("./workspace-monaco"));
const HEARTBEAT_INTERVAL_MS = 20_000;

type LiveWorkspace = {
  files: WorkspaceFile[];
  updatedAt: number;
  assignmentTitle: string;
  classroomName: string;
  studentDisplayName: string;
  studentUsername: string;
  language: "python" | "java";
  entrypoint: string;
  runtimeVersion: string;
};

export default function LiveWorkspaceViewer({ workspaceId }: { workspaceId: string }) {
  const [sessionId, setSessionId] = useState<string>();
  const enter = useMutation(api.liveWorkspaces.enter);
  const heartbeat = useMutation(api.liveWorkspaces.heartbeat);
  const leave = useMutation(api.liveWorkspaces.leave);
  const [entered, setEntered] = useState(false);
  const [activePath, setActivePath] = useState<string>();
  const [error, setError] = useState<string>();
  const workspace = useQuery(
    api.liveWorkspaces.watch,
    entered && sessionId ? { workspaceId, sessionId } : "skip",
  ) as LiveWorkspace | undefined;

  useEffect(() => {
    setSessionId(crypto.randomUUID());
  }, [workspaceId]);

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    let heartbeatTimer: number | undefined;
    void enter({ workspaceId, sessionId })
      .then(() => {
        if (!active) {
          void leave({ workspaceId, sessionId });
          return;
        }
        setEntered(true);
        heartbeatTimer = window.setInterval(() => {
          void heartbeat({ workspaceId, sessionId }).catch(() => {
            if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
            setEntered(false);
          });
        }, HEARTBEAT_INTERVAL_MS);
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(caught instanceof Error ? caught.message : "Could not open live Workspace");
        }
      });

    return () => {
      active = false;
      if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
      void leave({ workspaceId, sessionId });
    };
  }, [enter, heartbeat, leave, sessionId, workspaceId]);

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
          {workspace.language === "java" ? "Java" : "Python"} {workspace.runtimeVersion}
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
  const viewers = useQuery(api.liveWorkspaces.listViewers, { workspaceId }) as
    | { teacherId: string; displayName: string }[]
    | undefined;
  if (!viewers?.length) return null;
  return (
    <p role="status" className="border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
      {viewers.map(({ displayName }) => displayName).join(", ")}{" "}
      {viewers.length === 1 ? "is" : "are"} viewing your Workspace.
    </p>
  );
}
