// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkspaceEditor from "./workspace-editor";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(),
  languageUpdate: vi.fn(),
  prepareLanguageAdapter: vi.fn(() => ({ dispose: vi.fn() })),
  recorderStart: vi.fn(),
  recorderChange: vi.fn(),
  recorderRun: vi.fn(),
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
  env: { VITE_PYRIGHT_LANGUAGE_SERVICE_URL: "wss://languages.example.test/python" },
}));

vi.mock("./workspace-monaco", () => ({
  default: (props: typeof mocks.monacoProps) => {
    mocks.monacoProps = props;
    return null;
  },
}));

vi.mock("@/lib/python-language-service", () => ({
  RemotePythonLanguageService: class {
    connect = mocks.connect;
    disconnect = mocks.disconnect;
    updateFile = mocks.languageUpdate;
    reconnect = vi.fn(async () => undefined);
    getState = () => ({ status: "ready" });
    subscribeState = () => () => undefined;
  },
}));

vi.mock("@/lib/python-monaco-adapter", () => ({
  registerPythonMonacoAdapter: mocks.prepareLanguageAdapter,
}));

vi.mock("@/lib/work-history", () => ({
  createIndexedDbWorkHistoryOutbox: async () => ({}),
  WorkHistorySync: class {
    start = mocks.syncStart;
    stop = vi.fn();
    drain = vi.fn(async () => undefined);
  },
  WorkHistoryRecorder: class {
    start = mocks.recorderStart;
    flush = vi.fn(async () => undefined);
    observeOrigin = vi.fn();
    clearObservedOrigin = vi.fn();
    recordFileChange = mocks.recorderChange;
    recordRun = mocks.recorderRun;
  },
}));

describe("Workspace editor integration", () => {
  afterEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.monacoProps = undefined;
  });

  it("keeps editing, Work History, and Python intelligence on independent hooks", async () => {
    const onRun = vi.fn(async () => ({
      runId: "run-1",
      execution: { status: "completed" as const, stdout: "hello\n", stderr: "", exitCode: 0 },
      publicTestResults: [
        { name: "Greets", passed: true, stdout: "hello\n", stderr: "", exitCode: 0 },
      ],
    }));
    render(
      <WorkspaceEditor
        assignmentReleaseId="release-1"
        workspaceId="workspace-1"
        files={[{ path: "main.py", content: "print('before')\n" }]}
        entrypoint="main.py"
        runtimeVersion="3.12.0"
        onSave={vi.fn(async () => undefined)}
        onUploadHistory={vi.fn(async () => ({ acknowledgedThrough: 1 }))}
        onRun={onRun}
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
  });
});
