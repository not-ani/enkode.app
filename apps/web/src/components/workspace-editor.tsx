import { Button } from "@enkode.app/ui/components/button";
import { lazy, Suspense, useState, type FormEvent } from "react";

import type { WorkspaceLanguage } from "@/lib/language-intelligence";
import type { LanguageIntelligenceState } from "@/lib/python-language-service";
import type { WorkHistoryChunk } from "@/lib/work-history";
import type { StarterFileDecision, StarterFileMerge, WorkspaceFile } from "@/lib/workspace-state";

import {
  useWorkspaceController,
  type RunResult,
  type SubmissionResult,
} from "./use-workspace-controller";

export type { RunResult, SubmissionResult } from "./use-workspace-controller";

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
  const controller = useWorkspaceController({
    assignmentReleaseId,
    workspaceId,
    files,
    language,
    runtimeVersion,
    onSave,
    onUploadHistory,
    onRun,
    onSubmit,
    versionMerge,
    onCompleteVersionMerge,
  });
  const {
    activeFile,
    changeActiveFile,
    completeVersionMerge,
    error,
    intelligenceState,
    mergeState,
    mountEditor,
    prepareMonaco,
    reconnectIntelligence,
    run,
    runResult,
    runState,
    save,
    saveState,
    selectFile,
    state,
    submit,
    submissionResult,
    submitState,
  } = controller;

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
                onClick={() => selectFile(path)}
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
                reconnect={() => void reconnectIntelligence()}
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
                onChange={changeActiveFile}
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
