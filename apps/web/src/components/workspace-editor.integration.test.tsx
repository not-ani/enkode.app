// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkspaceEditor from "./workspace-editor";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(),
  languageUpdate: vi.fn(),
  serviceConfiguration: vi.fn(),
  languageState: { status: "ready" } as { status: "ready" } | { status: "failed"; message: string },
  prepareLanguageAdapter: vi.fn(() => ({ dispose: vi.fn() })),
  recorderStart: vi.fn(),
  recorderChange: vi.fn(),
  recorderRun: vi.fn(),
  recorderFinalize: vi.fn(async () => 2),
  recorderSubmission: vi.fn(),
  recorderVersionMerge: vi.fn(),
  syncDrainRequired: vi.fn(async () => undefined),
  syncStart: vi.fn(),
  monacoProps: undefined as
    | {
        beforeMount: (monaco: unknown) => void;
        onMount: (editor: unknown) => void;
        onChange: (content?: string) => void;
      }
    | undefined,
}));

vi.mock("@enkode.app/env/web", () => ({
  env: {
    VITE_PYRIGHT_LANGUAGE_SERVICE_URL: "wss://languages.example.test/python",
    VITE_JDTLS_LANGUAGE_SERVICE_URL: "wss://languages.example.test/java",
  },
}));

vi.mock("./workspace-monaco", () => ({
  default: (props: typeof mocks.monacoProps) => {
    mocks.monacoProps = props;
    return null;
  },
}));

vi.mock("@/lib/remote-language-service", () => ({
  RemoteLanguageService: class {
    constructor(...configuration: unknown[]) {
      mocks.serviceConfiguration(...configuration);
    }
    connect = mocks.connect;
    disconnect = mocks.disconnect;
    updateFile = mocks.languageUpdate;
    reconnect = vi.fn(async () => undefined);
    getState = () => mocks.languageState;
    subscribeState = () => () => undefined;
  },
}));

vi.mock("@/lib/remote-monaco-adapter", () => ({
  registerRemoteMonacoAdapter: mocks.prepareLanguageAdapter,
}));

vi.mock("@/lib/work-history", () => ({
  createIndexedDbWorkHistoryOutbox: async () => ({}),
  WorkHistorySync: class {
    start = mocks.syncStart;
    stop = vi.fn();
    drain = vi.fn(async () => undefined);
    drainRequired = mocks.syncDrainRequired;
  },
  WorkHistoryRecorder: class {
    start = mocks.recorderStart;
    flush = vi.fn(async () => undefined);
    observeOrigin = vi.fn();
    clearObservedOrigin = vi.fn();
    recordFileChange = mocks.recorderChange;
    recordRun = mocks.recorderRun;
    recordSubmission = mocks.recorderSubmission;
    recordAssignmentVersionMerge = mocks.recorderVersionMerge;
    finalize = mocks.recorderFinalize;
  },
}));

describe("Workspace editor integration", () => {
  afterEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.monacoProps = undefined;
    mocks.languageState = { status: "ready" };
  });

  it("keeps editing, Work History, and Python intelligence on independent hooks", async () => {
    const onRun = vi.fn(async () => ({
      runId: "run-1",
      execution: { status: "completed" as const, stdout: "hello\n", stderr: "", exitCode: 0 },
      publicTestResults: [
        { name: "Greets", passed: true, stdout: "hello\n", stderr: "", exitCode: 0 },
      ],
    }));
    const onSubmit = vi.fn(async () => ({
      _id: "submission-1",
      attemptNumber: 1,
      proposedPoints: 1,
      submittedAt: 1,
      testResults: [],
    }));
    render(
      <WorkspaceEditor
        assignmentReleaseId="release-1"
        workspaceId="workspace-1"
        files={[{ path: "main.py", content: "print('before')\n" }]}
        language="python"
        entrypoint="main.py"
        runtimeVersion="3.12.0"
        onSave={vi.fn(async () => undefined)}
        onUploadHistory={vi.fn(async () => ({ acknowledgedThrough: 1 }))}
        onRun={onRun}
        submissions={[]}
        onSubmit={onSubmit}
        onCompleteVersionMerge={vi.fn(async () => undefined)}
      />,
    );

    await waitFor(() => expect(mocks.monacoProps).toBeDefined());
    await waitFor(() => expect(mocks.recorderStart).toHaveBeenCalledOnce());
    expect(mocks.connect).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      runtime: { language: "python", version: "3.12.0" },
      files: [{ path: "main.py", content: "print('before')\n" }],
    });

    mocks.monacoProps!.beforeMount({});
    let recordModelChange: ((event: unknown) => void) | undefined;
    mocks.monacoProps!.onMount({
      getDomNode: () => null,
      getAction: () => null,
      onKeyDown: () => ({ dispose: vi.fn() }),
      onDidChangeModelContent: (listener: (event: unknown) => void) => {
        recordModelChange = listener;
        return { dispose: vi.fn() };
      },
      onDidDispose: vi.fn(),
    });

    await act(() => mocks.monacoProps!.onChange("print('after')\n"));
    recordModelChange?.({
      changes: [{ rangeOffset: 7, rangeLength: 6, text: "'after'" }],
      isUndoing: false,
      isRedoing: false,
    });

    expect(mocks.prepareLanguageAdapter).toHaveBeenCalledOnce();
    expect(mocks.languageUpdate).toHaveBeenCalledWith("main.py", "print('after')\n");
    expect(mocks.recorderChange).toHaveBeenCalledWith(
      "main.py",
      [{ rangeOffset: 7, rangeLength: 6, text: "'after'" }],
      undefined,
    );

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText("1 of 1 public tests passed");
    expect(onRun).toHaveBeenCalledWith([{ path: "main.py", content: "print('after')\n" }]);
    expect(mocks.recorderRun).toHaveBeenCalledWith({
      runId: "run-1",
      status: "completed",
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
      publicTestResults: [expect.objectContaining({ name: "Greets", passed: true })],
    });

    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await screen.findByText("Attempt 1 submitted");
    expect(mocks.recorderFinalize).toHaveBeenCalledOnce();
    expect(mocks.syncDrainRequired).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith(
      [{ path: "main.py", content: "print('after')\n" }],
      2,
      expect.any(String),
    );
    expect(mocks.recorderSubmission).toHaveBeenCalledWith({
      submissionId: "submission-1",
      attemptNumber: 1,
      proposedPoints: 1,
    });
  });

  it("requires acknowledgement and records accepted starter changes before completing a merge", async () => {
    const onCompleteVersionMerge = vi.fn(async () => undefined);
    render(
      <WorkspaceEditor
        assignmentReleaseId="release-1"
        workspaceId="workspace-1"
        files={[{ path: "main.py", content: "print('student')\n" }]}
        language="python"
        entrypoint="main.py"
        runtimeVersion="3.12.0"
        onSave={vi.fn(async () => undefined)}
        onUploadHistory={vi.fn(async () => ({ acknowledgedThrough: 1 }))}
        onRun={vi.fn()}
        submissions={[]}
        onSubmit={vi.fn()}
        versionMerge={{
          mergeId: "merge-1",
          fromVersion: 1,
          toVersion: 2,
          fromAssignmentVersionId: "version-1",
          toAssignmentVersionId: "version-2",
          changedStarterFiles: [
            {
              path: "main.py",
              kind: "modified",
              previousContent: "print('hello')\n",
              incomingContent: "print('updated')\n",
              currentContent: "print('student')\n",
            },
            {
              path: "notes.txt",
              kind: "added",
              incomingContent: "Read me\n",
            },
          ],
        }}
        onCompleteVersionMerge={onCompleteVersionMerge}
      />,
    );

    await waitFor(() => expect(mocks.recorderStart).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Apply Assignment update" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getAllByLabelText("Use updated starter")[1]!);
    fireEvent.click(
      screen.getByLabelText(
        "I reviewed every changed starter file and understand these choices update my Workspace.",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply Assignment update" }));

    await waitFor(() => expect(onCompleteVersionMerge).toHaveBeenCalledOnce());
    expect(mocks.recorderVersionMerge).toHaveBeenCalledWith({
      files: [
        { path: "main.py", content: "print('student')\n" },
        { path: "notes.txt", content: "Read me\n" },
      ],
      fromAssignmentVersionId: "version-1",
      toAssignmentVersionId: "version-2",
      acceptedPaths: ["notes.txt"],
    });
    expect(mocks.syncDrainRequired).toHaveBeenCalledOnce();
    expect(onCompleteVersionMerge).toHaveBeenCalledWith(
      "merge-1",
      [
        { path: "main.py", choice: "keep_current" },
        { path: "notes.txt", choice: "accept_new" },
      ],
      2,
    );
  });

  it("keeps Java editing and Work History available while JDT LS is degraded", async () => {
    mocks.languageState = { status: "failed", message: "JDT LS unavailable" };
    render(
      <WorkspaceEditor
        assignmentReleaseId="release-java"
        workspaceId="workspace-java"
        files={[{ path: "Main.java", content: "public class Main {}\n" }]}
        language="java"
        entrypoint="Main.java"
        runtimeVersion="15.0.2"
        onSave={vi.fn(async () => undefined)}
        onUploadHistory={vi.fn(async () => ({ acknowledgedThrough: 1 }))}
        onRun={vi.fn()}
        submissions={[]}
        onSubmit={vi.fn()}
        onCompleteVersionMerge={vi.fn(async () => undefined)}
      />,
    );

    await screen.findByText("Java intelligence unavailable");
    await waitFor(() => expect(mocks.recorderStart).toHaveBeenCalledOnce());
    expect(mocks.serviceConfiguration).toHaveBeenCalledWith(
      "java",
      "jdtls",
      "wss://languages.example.test/java",
      expect.anything(),
    );

    await act(() => mocks.monacoProps!.onChange("public class Main { int answer = 42; }\n"));
    expect(mocks.languageUpdate).toHaveBeenCalledWith(
      "Main.java",
      "public class Main { int answer = 42; }\n",
    );
    expect(screen.getByText("Unsaved")).toBeDefined();
  });
});
