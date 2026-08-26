import { Button } from "@enkode.app/ui/components/button";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

import {
  createLocalWorkspaceDraftStore,
  editWorkspaceFile,
  restoreWorkspaceState,
  workspaceDraftMatches,
  type WorkspaceFile,
} from "@/lib/workspace-state";

const MonacoEditor = lazy(() => import("./workspace-monaco"));

type WorkspaceEditorProps = {
  assignmentReleaseId: string;
  workspaceId: string;
  files: WorkspaceFile[];
  entrypoint: string;
  onSave: (files: WorkspaceFile[]) => Promise<void>;
};

export default function WorkspaceEditor({
  assignmentReleaseId,
  workspaceId,
  files,
  entrypoint,
  onSave,
}: WorkspaceEditorProps) {
  const draftStore = useMemo(
    () =>
      typeof window === "undefined" ? undefined : createLocalWorkspaceDraftStore(localStorage),
    [],
  );
  const restoredDraft = useMemo(
    () => draftStore?.load(assignmentReleaseId),
    [assignmentReleaseId, draftStore],
  );
  const [state, setState] = useState(() =>
    restoreWorkspaceState(workspaceId, files, restoredDraft),
  );
  const [saveState, setSaveState] = useState<"dirty" | "saving" | "saved">(() =>
    workspaceDraftMatches(workspaceId, files, restoredDraft) ? "dirty" : "saved",
  );
  const [error, setError] = useState<string>();
  const latest = useRef({ state, saveState });
  latest.current = { state, saveState };
  const activeFile = state.files.find(({ path }) => path === state.activePath) ?? state.files[0]!;

  useEffect(() => {
    if (saveState !== "dirty" || !draftStore) return;
    const timer = window.setTimeout(() => {
      draftStore.save(assignmentReleaseId, { workspaceId, ...state });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [assignmentReleaseId, draftStore, saveState, state, workspaceId]);

  useEffect(
    () => () => {
      if (latest.current.saveState === "dirty") {
        draftStore?.save(assignmentReleaseId, { workspaceId, ...latest.current.state });
      }
    },
    [assignmentReleaseId, draftStore, workspaceId],
  );

  async function save() {
    setSaveState("saving");
    setError(undefined);
    try {
      await onSave(state.files);
      draftStore?.remove(assignmentReleaseId);
      setSaveState("saved");
    } catch (caught) {
      draftStore?.save(assignmentReleaseId, { workspaceId, ...state });
      setSaveState("dirty");
      setError(caught instanceof Error ? caught.message : "Could not save this Workspace");
    }
  }

  return (
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
          {state.files.map(({ path }) => (
            <button
              type="button"
              role="tab"
              aria-selected={path === activeFile.path}
              className="shrink-0 border-l-2 border-transparent px-3 py-2 text-left font-mono text-sm hover:bg-muted aria-selected:border-primary aria-selected:bg-muted"
              onClick={() => setState((current) => ({ ...current, activePath: path }))}
              key={path}
            >
              {path}
              {path === entrypoint ? <span className="sr-only"> (entrypoint)</span> : null}
            </button>
          ))}
        </div>
      </aside>
      <div className="flex min-w-0 flex-col">
        <div className="flex min-h-12 items-center justify-between gap-3 border-b border-foreground/10 px-3">
          <p className="truncate font-mono text-sm">{activeFile.path}</p>
          <div className="flex items-center gap-3">
            <p aria-live="polite" className="text-xs text-muted-foreground">
              {saveState === "dirty" ? "Unsaved" : saveState === "saving" ? "Saving…" : "Saved"}
            </p>
            <Button
              type="button"
              size="sm"
              disabled={saveState !== "dirty"}
              onClick={() => void save()}
            >
              Save
            </Button>
          </div>
        </div>
        {error ? (
          <p className="border-b border-foreground/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="min-h-0 flex-1">
          <Suspense
            fallback={<div className="p-4 text-sm text-muted-foreground">Loading editor…</div>}
          >
            <MonacoEditor
              height="100%"
              language="python"
              path={`enkode://${workspaceId}/${activeFile.path}`}
              value={activeFile.content}
              onChange={(content) => {
                setState((current) => editWorkspaceFile(current, activeFile.path, content ?? ""));
                setSaveState("dirty");
              }}
              options={{
                automaticLayout: true,
                minimap: { enabled: false },
                padding: { top: 12 },
                scrollBeyondLastLine: false,
                tabSize: 4,
              }}
            />
          </Suspense>
        </div>
      </div>
    </section>
  );
}
