import { Button } from "@enkode.app/ui/components/button";
import { env } from "@enkode.app/env/web";
import type { OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor/editor/editor.api";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  createIndexedDbWorkHistoryOutbox,
  WorkHistoryRecorder,
  WorkHistorySync,
  type WorkHistoryChunk,
} from "@/lib/work-history";

import { WebSocketLanguageServiceTransport } from "@/lib/language-service-websocket";
import {
  BrowserLocalLanguageService,
  registerEnkodeMonacoLanguageAdapter,
  type WorkspaceLanguage,
  type WorkspaceLanguageService,
} from "@/lib/language-intelligence";
import {
  type LanguageIntelligenceState,
  RemotePythonLanguageService,
} from "@/lib/python-language-service";
import { RemoteJavaLanguageService } from "@/lib/java-language-service";
import {
  createLocalWorkspaceDraftStore,
  createWorkspaceState,
  editWorkspaceFile,
  applyStarterFileDecisions,
  restoreWorkspaceState,
  workspaceDraftMatches,
  type WorkspaceFile,
  type StarterFileDecision,
  type StarterFileMerge,
} from "@/lib/workspace-state";

const MonacoEditor = lazy(() => import("./workspace-monaco"));

type WorkspaceEditorProps = {
  assignmentReleaseId: string;
  workspaceId: string;
  files: WorkspaceFile[];
  language: WorkspaceLanguage;
  entrypoint: string;
  runtimeVersion: string;
  onSave: (files: WorkspaceFile[]) => Promise<void>;
  onUploadHistory: (chunk: WorkHistoryChunk) => Promise<{ acknowledgedThrough: number }>;
  onRun: (files: WorkspaceFile[]) => Promise<RunResult>;
  onSubmit: (
    files: WorkspaceFile[],
    requiredHistorySequence: number,
    idempotencyKey: string,
  ) => Promise<SubmissionResult>;
  submissions: SubmissionResult[];
  versionMerge?: {
    mergeId: string;
    fromVersion: number;
    toVersion: number;
    fromAssignmentVersionId: string;
    toAssignmentVersionId: string;
    changedStarterFiles: StarterFileMerge[];
  };
  onCompleteVersionMerge: (
    mergeId: string,
    decisions: StarterFileDecision[],
    requiredHistorySequence: number,
  ) => Promise<void>;
  submissionEligibility?: {
    canSubmit: boolean;
    reason?: string;
    remainingAttempts?: number;
  };
};

export type RunResult = {
  runId: string;
  execution: {
    status: "completed" | "failed" | "timed_out";
    stdout: string;
    stderr: string;
    exitCode: number | null;
  };
  publicTestResults: {
    name: string;
    passed: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
  }[];
};

export type SubmissionResult = {
  _id: string;
  attemptNumber: number;
  proposedPoints: number;
  submittedAt: number;
  late?: boolean;
  current?: boolean;
  testResults: {
    visibility: "public" | "hidden";
    name?: string;
    weight: number;
    passed: boolean;
    guidance?: string;
  }[];
};

export default function WorkspaceEditor({
  assignmentReleaseId,
  workspaceId,
  files,
  language,
  entrypoint,
  runtimeVersion,
  onSave,
  onUploadHistory,
  onRun,
  onSubmit,
  submissions,
  versionMerge,
  onCompleteVersionMerge,
  submissionEligibility = { canSubmit: true },
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
  const [runState, setRunState] = useState<"idle" | "running">("idle");
  const [runResult, setRunResult] = useState<RunResult>();
  const [submitState, setSubmitState] = useState<"idle" | "submitting">("idle");
  const [submissionResult, setSubmissionResult] = useState<SubmissionResult>();
  const [mergeState, setMergeState] = useState<"idle" | "applying">("idle");
  const languageService = useMemo<WorkspaceLanguageService>(
    () =>
      language === "python"
        ? (new RemotePythonLanguageService(
            env.VITE_PYRIGHT_LANGUAGE_SERVICE_URL,
            new WebSocketLanguageServiceTransport(),
          ) as unknown as WorkspaceLanguageService)
        : language === "java"
          ? (new RemoteJavaLanguageService(
              env.VITE_JDTLS_LANGUAGE_SERVICE_URL,
              new WebSocketLanguageServiceTransport(),
            ) as unknown as WorkspaceLanguageService)
          : new BrowserLocalLanguageService(language),
    [language],
  );
  const [intelligenceState, setIntelligenceState] = useState<LanguageIntelligenceState>(() =>
    languageService.getState(),
  );
  const monacoAdapter = useRef<{ dispose: () => void } | undefined>(undefined);
  const initialFiles = useRef(state.files);
  const latest = useRef({ state, saveState });
  const historyRecorder = useRef<WorkHistoryRecorder | undefined>(undefined);
  const historySync = useRef<WorkHistorySync | undefined>(undefined);
  const submitRequestId = useRef<string | undefined>(undefined);
  const activeFile = state.files.find(({ path }) => path === state.activePath) ?? state.files[0]!;

  useEffect(() => {
    latest.current = { state, saveState };
  }, [saveState, state]);

  useEffect(() => languageService.subscribeState(setIntelligenceState), [languageService]);

  useEffect(() => {
    void languageService.connect({
      workspaceId,
      runtime: { language, version: runtimeVersion },
      files: initialFiles.current,
    });
    return () => languageService.disconnect();
  }, [language, languageService, runtimeVersion, workspaceId]);

  useEffect(() => () => monacoAdapter.current?.dispose(), []);

  const prepareMonaco = useCallback(
    (monaco: typeof Monaco) => {
      monacoAdapter.current?.dispose();
      monacoAdapter.current = registerEnkodeMonacoLanguageAdapter(monaco, {
        language,
        service: languageService,
        workspaceId,
      });
    },
    [language, languageService, workspaceId],
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

  useEffect(() => {
    let disposed = false;
    let sync: WorkHistorySync | undefined;
    let recorder: WorkHistoryRecorder | undefined;
    void createIndexedDbWorkHistoryOutbox()
      .then((outbox) => {
        if (disposed) return;
        sync = new WorkHistorySync(workspaceId, outbox, onUploadHistory);
        recorder = new WorkHistoryRecorder(
          workspaceId,
          outbox,
          () => latest.current.state.files,
          () => void sync?.drain(),
        );
        historyRecorder.current = recorder;
        historySync.current = sync;
        sync.start();
        recorder.start();
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      if (historyRecorder.current === recorder) historyRecorder.current = undefined;
      if (historySync.current === sync) historySync.current = undefined;
      void recorder?.flush();
      sync?.stop();
    };
  }, [onUploadHistory, workspaceId]);

  const mountEditor = useCallback<OnMount>((editor) => {
    const domNode = editor.getDomNode();
    const observePaste = () => historyRecorder.current?.observeOrigin("paste");
    domNode?.addEventListener("paste", observePaste, true);
    const keyDisposable = editor.onKeyDown((event) => {
      const key = event.browserEvent.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "z") {
        historyRecorder.current?.observeOrigin(event.shiftKey ? "redo" : "undo");
      } else if ((event.ctrlKey || event.metaKey) && key === "y") {
        historyRecorder.current?.observeOrigin("redo");
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
        historyRecorder.current?.observeOrigin("typing", 100);
      }
    });
    const changeDisposable = editor.onDidChangeModelContent((event) => {
      historyRecorder.current?.recordFileChange(
        latest.current.state.activePath,
        event.changes.map(({ rangeOffset, rangeLength, text }) => ({
          rangeOffset,
          rangeLength,
          text,
        })),
        event.isUndoing ? "undo" : event.isRedoing ? "redo" : undefined,
      );
    });
    const wrappedActions = [
      ["acceptSelectedSuggestion", "completion"],
      ["editor.action.inlineSuggest.commit", "completion"],
      ["editor.action.formatDocument", "formatting"],
      ["editor.action.formatSelection", "formatting"],
      ["editor.action.quickFix", "quick-fix"],
      ["editor.action.rename", "rename"],
    ] as const;
    const restoreActions = wrappedActions.flatMap(([id, origin]) => {
      const action = editor.getAction(id);
      if (!action) return [];
      const run = action.run.bind(action);
      action.run = async (args?: unknown) => {
        historyRecorder.current?.observeOrigin(origin, 10_000);
        try {
          await run(args);
        } finally {
          historyRecorder.current?.clearObservedOrigin(origin);
        }
      };
      return [() => (action.run = run)];
    });
    editor.onDidDispose(() => {
      domNode?.removeEventListener("paste", observePaste, true);
      keyDisposable.dispose();
      changeDisposable.dispose();
      for (const restore of restoreActions) restore();
    });
  }, []);

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

  async function run() {
    setRunState("running");
    setRunResult(undefined);
    setError(undefined);
    try {
      const result = await onRun(state.files);
      setRunResult(result);
      historyRecorder.current?.recordRun({
        runId: result.runId,
        status: result.execution.status,
        stdout: result.execution.stdout,
        stderr: result.execution.stderr,
        exitCode: result.execution.exitCode,
        publicTestResults: result.publicTestResults,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not Run this Workspace");
    } finally {
      setRunState("idle");
    }
  }

  async function submit() {
    setSubmitState("submitting");
    setSubmissionResult(undefined);
    setError(undefined);
    try {
      if (saveState === "dirty") {
        await onSave(state.files);
        draftStore?.remove(assignmentReleaseId);
        setSaveState("saved");
      }
      const recorder = historyRecorder.current;
      const sync = historySync.current;
      if (!recorder || !sync) throw new Error("Work History is still starting");
      const requiredHistorySequence = await recorder.finalize();
      await sync.drainRequired();
      const idempotencyKey = (submitRequestId.current ??= crypto.randomUUID());
      const result = await onSubmit(state.files, requiredHistorySequence, idempotencyKey);
      submitRequestId.current = undefined;
      setSubmissionResult(result);
      recorder.recordSubmission({
        submissionId: result._id,
        attemptNumber: result.attemptNumber,
        proposedPoints: result.proposedPoints,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not Submit this Workspace");
    } finally {
      setSubmitState("idle");
    }
  }

  async function completeVersionMerge(decisions: StarterFileDecision[], acknowledged: boolean) {
    if (!versionMerge || !acknowledged) return;
    setMergeState("applying");
    setError(undefined);
    try {
      if (saveState === "dirty") await onSave(state.files);
      const nextFiles = applyStarterFileDecisions(
        state.files,
        versionMerge.changedStarterFiles,
        decisions,
      );
      const recorder = historyRecorder.current;
      const sync = historySync.current;
      if (!recorder || !sync) throw new Error("Work History is still starting");
      recorder.recordAssignmentVersionMerge({
        files: nextFiles,
        fromAssignmentVersionId: versionMerge.fromAssignmentVersionId,
        toAssignmentVersionId: versionMerge.toAssignmentVersionId,
        acceptedPaths: decisions
          .filter(({ choice }) => choice === "accept_new")
          .map(({ path }) => path),
      });
      latest.current = {
        state: createWorkspaceState(nextFiles, state.activePath),
        saveState: "saved",
      };
      const requiredHistorySequence = await recorder.finalize();
      await sync.drainRequired();
      await onCompleteVersionMerge(versionMerge.mergeId, decisions, requiredHistorySequence);
      draftStore?.remove(assignmentReleaseId);
      initialFiles.current = nextFiles;
      for (const file of nextFiles) languageService.updateFile(file.path, file.content);
      setState(createWorkspaceState(nextFiles, state.activePath));
      setSaveState("saved");
    } catch (caught) {
      latest.current = { state, saveState };
      setError(caught instanceof Error ? caught.message : "Could not apply the Assignment update");
    } finally {
      setMergeState("idle");
    }
  }

  return (
    <>
      {versionMerge ? (
        <VersionMergePanel
          merge={versionMerge}
          applying={mergeState === "applying"}
          onApply={completeVersionMerge}
        />
      ) : null}
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
                language={language}
                state={intelligenceState}
                reconnect={() => void languageService.reconnect()}
              />
              <p aria-live="polite" className="text-xs text-muted-foreground">
                {saveState === "dirty" ? "Unsaved" : saveState === "saving" ? "Saving…" : "Saved"}
              </p>
              <Button
                type="button"
                size="sm"
                disabled={runState === "running" || submitState === "submitting"}
                onClick={() => void run()}
              >
                {runState === "running" ? "Running…" : "Run"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  !submissionEligibility.canSubmit ||
                  submitState === "submitting" ||
                  runState === "running" ||
                  saveState === "saving"
                }
                onClick={() => void submit()}
              >
                {submitState === "submitting" ? "Submitting…" : "Submit"}
              </Button>
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
          {!submissionEligibility.canSubmit && submissionEligibility.reason ? (
            <p className="border-b border-foreground/10 px-3 py-2 text-sm text-muted-foreground">
              Submit unavailable: {submissionEligibility.reason}.
            </p>
          ) : null}
          <div className="min-h-0 flex-1">
            <Suspense
              fallback={<div className="p-4 text-sm text-muted-foreground">Loading editor…</div>}
            >
              <MonacoEditor
                height="100%"
                language={language}
                path={`enkode://${workspaceId}/${activeFile.path}`}
                value={activeFile.content}
                beforeMount={prepareMonaco}
                onMount={mountEditor}
                onChange={(content) => {
                  const nextContent = content ?? "";
                  submitRequestId.current = undefined;
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
        {runResult ? <RunResults result={runResult} /> : null}
        {submissionResult ? <SubmissionResults result={submissionResult} /> : null}
        {submissions.length > 0 ? <SubmissionHistory submissions={submissions} /> : null}
      </section>
    </>
  );
}

function VersionMergePanel({
  merge,
  applying,
  onApply,
}: {
  merge: NonNullable<WorkspaceEditorProps["versionMerge"]>;
  applying: boolean;
  onApply: (decisions: StarterFileDecision[], acknowledged: boolean) => Promise<void>;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const decisions = merge.changedStarterFiles.map(({ path }) => ({
      path,
      choice:
        form.get(`decision:${path}`) === "accept_new"
          ? ("accept_new" as const)
          : ("keep_current" as const),
    }));
    void onApply(decisions, acknowledged);
  }
  return (
    <form className="border border-amber-500/40 bg-amber-500/5 p-4" onSubmit={submit}>
      <h2 className="font-medium">Assignment Version {merge.toVersion} is available</h2>
      <p className="mt-1 max-w-[75ch] text-sm text-muted-foreground">
        Your Workspace remains on Version {merge.fromVersion} until you decide how to handle every
        changed starter file. Your current files will not be replaced automatically.
      </p>
      <ul className="mt-4 grid gap-3">
        {merge.changedStarterFiles.map((file) => (
          <li className="border border-foreground/10 bg-background p-3" key={file.path}>
            <p className="font-mono text-sm">
              {file.path} · {file.kind}
            </p>
            <details className="mt-2">
              <summary className="cursor-pointer text-sm font-medium">Compare contents</summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs text-muted-foreground">Your current file</p>
                  <pre className="max-h-64 overflow-auto border border-foreground/10 p-2 text-xs">
                    {file.currentContent ?? "File does not exist"}
                  </pre>
                </div>
                <div>
                  <p className="mb-1 text-xs text-muted-foreground">Updated starter</p>
                  <pre className="max-h-64 overflow-auto border border-foreground/10 p-2 text-xs">
                    {file.incomingContent ?? "File will be removed"}
                  </pre>
                </div>
              </div>
            </details>
            <div className="mt-2 flex flex-wrap gap-4 text-sm">
              <label>
                <input
                  type="radio"
                  name={`decision:${file.path}`}
                  value="keep_current"
                  defaultChecked
                />{" "}
                Keep my current file
              </label>
              <label>
                <input type="radio" name={`decision:${file.path}`} value="accept_new" />{" "}
                {file.kind === "removed" ? "Accept removal" : "Use updated starter"}
              </label>
            </div>
          </li>
        ))}
      </ul>
      <label className="mt-4 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        I reviewed every changed starter file and understand these choices update my Workspace.
      </label>
      <Button className="mt-3" type="submit" disabled={!acknowledged || applying}>
        {applying ? "Applying update…" : "Apply Assignment update"}
      </Button>
    </form>
  );
}

function SubmissionResults({ result }: { result: SubmissionResult }) {
  return (
    <section
      className="border-t border-foreground/10 bg-muted/20 p-4 lg:col-span-2"
      aria-label="Submission results"
    >
      <h2 className="font-medium">Attempt {result.attemptNumber} submitted</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Proposed points: {result.proposedPoints}
        {result.late ? " · Late" : ""}
      </p>
      <ul className="mt-3 grid gap-2">
        {result.testResults.map((test, index) => (
          <li
            className="border border-foreground/10 bg-background px-3 py-2 text-sm"
            key={`${test.visibility}-${index}`}
          >
            <span>
              {test.visibility === "public" ? test.name : "Hidden test"}:{" "}
              {test.passed ? "Passed" : "Failed"}
            </span>
            {test.visibility === "hidden" && test.guidance ? (
              <p className="mt-1 text-muted-foreground">{test.guidance}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SubmissionHistory({ submissions }: { submissions: SubmissionResult[] }) {
  return (
    <section
      className="border-t border-foreground/10 p-4 lg:col-span-2"
      aria-label="Submission history"
    >
      <h2 className="font-medium">Submission history</h2>
      <ol className="mt-2 grid gap-1 text-sm text-muted-foreground">
        {submissions.map((submission) => (
          <li key={submission._id}>
            Attempt {submission.attemptNumber} · {submission.proposedPoints} proposed points
            {submission.late ? " · Late" : ""}
            {submission.current ? " · Current" : ""}
          </li>
        ))}
      </ol>
    </section>
  );
}

function RunResults({ result }: { result: RunResult }) {
  const passed = result.publicTestResults.filter((test) => test.passed).length;
  return (
    <section
      className="border-t border-foreground/10 bg-muted/20 p-4 lg:col-span-2"
      aria-label="Run results"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">Run results</h2>
        <p className="text-sm text-muted-foreground">
          {result.publicTestResults.length === 0
            ? result.execution.status === "completed"
              ? "Completed"
              : "Execution failed"
            : `${passed} of ${result.publicTestResults.length} public tests passed`}
        </p>
      </div>
      {result.execution.stdout ? (
        <pre
          className="mt-3 overflow-x-auto bg-background p-3 text-sm"
          aria-label="Standard output"
        >
          {result.execution.stdout}
        </pre>
      ) : null}
      {result.execution.stderr ? (
        <pre
          className="mt-3 overflow-x-auto bg-background p-3 text-sm text-destructive"
          aria-label="Standard error"
        >
          {result.execution.stderr}
        </pre>
      ) : null}
      {result.publicTestResults.length > 0 ? (
        <ul className="mt-3 grid gap-2">
          {result.publicTestResults.map((test, index) => (
            <li
              className="flex items-center justify-between border border-foreground/10 bg-background px-3 py-2 text-sm"
              key={`${test.name}-${index}`}
            >
              <span>{test.name}</span>
              <span className={test.passed ? "text-emerald-700" : "text-destructive"}>
                {test.passed ? "Passed" : "Failed"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function LanguageIntelligenceStatus({
  language,
  state,
  reconnect,
}: {
  language: WorkspaceLanguage;
  state: LanguageIntelligenceState;
  reconnect: () => void;
}) {
  const languageName = {
    python: "Python",
    javascript: "JavaScript",
    typescript: "TypeScript",
    java: "Java",
  }[language];
  const label = {
    disconnected: "Intelligence disconnected",
    connecting: "Intelligence connecting…",
    ready: `${languageName} intelligence ready`,
    failed: `${languageName} intelligence unavailable`,
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
