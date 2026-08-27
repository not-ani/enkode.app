import { env } from "@enkode.app/env/web";
import type { OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor/editor/editor.api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { RemoteJavaLanguageService } from "@/lib/java-language-service";
import { messageFrom } from "@/lib/error-message";
import { WebSocketLanguageServiceTransport } from "@/lib/language-service-websocket";
import {
  BrowserLocalLanguageService,
  registerEnkodeMonacoLanguageAdapter,
  type WorkspaceLanguage,
  type WorkspaceLanguageService,
} from "@/lib/language-intelligence";
import type { LanguageIntelligenceState } from "@/lib/python-language-service";
import { RemotePythonLanguageService } from "@/lib/python-language-service";
import {
  createIndexedDbWorkHistoryOutbox,
  WorkHistoryRecorder,
  WorkHistorySync,
  type WorkHistoryChunk,
} from "@/lib/work-history";
import {
  applyStarterFileDecisions,
  createLocalWorkspaceDraftStore,
  createWorkspaceState,
  editWorkspaceFile,
  restoreWorkspaceState,
  workspaceDraftMatches,
  type StarterFileDecision,
  type StarterFileMerge,
  type WorkspaceFile,
} from "@/lib/workspace-state";

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

export type WorkspaceControllerInput = {
  assignmentReleaseId: string;
  workspaceId: string;
  files: WorkspaceFile[];
  language: WorkspaceLanguage;
  runtimeVersion: string;
  onSave: (files: WorkspaceFile[]) => Promise<void>;
  onUploadHistory: (chunk: WorkHistoryChunk) => Promise<{ acknowledgedThrough: number }>;
  onRun: (files: WorkspaceFile[]) => Promise<RunResult>;
  onSubmit: (
    files: WorkspaceFile[],
    requiredHistorySequence: number,
    idempotencyKey: string,
  ) => Promise<SubmissionResult>;
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
};

function createLanguageService(language: WorkspaceLanguage): WorkspaceLanguageService {
  if (language === "python") {
    return new RemotePythonLanguageService(
      env.VITE_PYRIGHT_LANGUAGE_SERVICE_URL,
      new WebSocketLanguageServiceTransport(),
    );
  }
  if (language === "java") {
    return new RemoteJavaLanguageService(
      env.VITE_JDTLS_LANGUAGE_SERVICE_URL,
      new WebSocketLanguageServiceTransport(),
    );
  }
  return new BrowserLocalLanguageService(language);
}

function observePaste(element: HTMLElement | null, listener: () => void) {
  if (!element) return () => undefined;
  element.addEventListener("paste", listener, true);
  return () => element.removeEventListener("paste", listener, true);
}

export function useWorkspaceController({
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
}: WorkspaceControllerInput) {
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
  const languageService = useMemo(() => createLanguageService(language), [language]);
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
    const stopObservingPaste = observePaste(domNode, () =>
      historyRecorder.current?.observeOrigin("paste"),
    );
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
      stopObservingPaste();
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
      setError(messageFrom(caught, "Could not save this Workspace"));
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
      setError(messageFrom(caught, "Could not Run this Workspace"));
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
      setError(messageFrom(caught, "Could not Submit this Workspace"));
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
      setError(messageFrom(caught, "Could not apply the Assignment update"));
    } finally {
      setMergeState("idle");
    }
  }

  function selectFile(path: string) {
    setState((current) => ({ ...current, activePath: path }));
  }

  function changeActiveFile(content = "") {
    submitRequestId.current = undefined;
    setState((current) => editWorkspaceFile(current, activeFile.path, content));
    setSaveState("dirty");
    languageService.updateFile(activeFile.path, content);
  }

  return {
    activeFile,
    changeActiveFile,
    completeVersionMerge,
    error,
    intelligenceState,
    mergeState,
    mountEditor,
    prepareMonaco,
    reconnectIntelligence: () => languageService.reconnect(),
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
  };
}
