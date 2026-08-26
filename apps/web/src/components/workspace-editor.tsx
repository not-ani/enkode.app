import { Button } from "@enkode.app/ui/components/button";
import { env } from "@enkode.app/env/web";
import type * as Monaco from "monaco-editor/editor/editor.api";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { WebSocketLanguageServiceTransport } from "@/lib/language-service-websocket";
import {
  type LanguageIntelligenceState,
  RemotePythonLanguageService,
} from "@/lib/python-language-service";
import { registerPythonMonacoAdapter } from "@/lib/python-monaco-adapter";
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
  runtimeVersion: string;
  onSave: (files: WorkspaceFile[]) => Promise<void>;
};

export default function WorkspaceEditor({
  assignmentReleaseId,
  workspaceId,
  files,
  entrypoint,
  runtimeVersion,
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
  const languageService = useMemo(
    () =>
      new RemotePythonLanguageService(
        env.VITE_PYRIGHT_LANGUAGE_SERVICE_URL,
        new WebSocketLanguageServiceTransport(),
      ),
    [],
  );
  const [intelligenceState, setIntelligenceState] = useState<LanguageIntelligenceState>(() =>
    languageService.getState(),
  );
  const monacoAdapter = useRef<{ dispose: () => void } | undefined>(undefined);
  const initialFiles = useRef(state.files);
  const latest = useRef({ state, saveState });
  const activeFile = state.files.find(({ path }) => path === state.activePath) ?? state.files[0]!;

  useEffect(() => {
    latest.current = { state, saveState };
  }, [saveState, state]);

  useEffect(() => languageService.subscribeState(setIntelligenceState), [languageService]);

  useEffect(() => {
    void languageService.connect({
      workspaceId,
      runtime: { language: "python", version: runtimeVersion },
      files: initialFiles.current,
    });
    return () => languageService.disconnect();
  }, [languageService, runtimeVersion, workspaceId]);

  useEffect(() => () => monacoAdapter.current?.dispose(), []);

  const prepareMonaco = useCallback(
    (monaco: typeof Monaco) => {
      monacoAdapter.current?.dispose();
      monacoAdapter.current = registerPythonMonacoAdapter(monaco, languageService, workspaceId);
    },
    [languageService, workspaceId],
  );

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
            <LanguageIntelligenceStatus
              state={intelligenceState}
              reconnect={() => void languageService.reconnect()}
            />
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
              beforeMount={prepareMonaco}
              onChange={(content) => {
                const nextContent = content ?? "";
                setState((current) => editWorkspaceFile(current, activeFile.path, nextContent));
                setSaveState("dirty");
                languageService.updateFile(activeFile.path, nextContent);
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

function LanguageIntelligenceStatus({
  state,
  reconnect,
}: {
  state: LanguageIntelligenceState;
  reconnect: () => void;
}) {
  const label = {
    disconnected: "Intelligence disconnected",
    connecting: "Intelligence connecting…",
    ready: "Python intelligence ready",
    failed: "Python intelligence unavailable",
  }[state.status];
  return (
    <div className="flex items-center gap-2">
      <p
        aria-live="polite"
        title={state.status === "failed" ? state.message : undefined}
        className="text-xs text-muted-foreground"
      >
        {label}
      </p>
      {state.status === "failed" || state.status === "disconnected" ? (
        <button
          type="button"
          className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
          onClick={reconnect}
        >
          Reconnect
        </button>
      ) : null}
    </div>
  );
}
