import { describe, expect, it, vi } from "vitest";

import {
  RemotePythonLanguageService,
  type LanguageServiceConnection,
  type LanguageServiceTransport,
} from "./python-language-service";

const configuration = {
  workspaceId: "workspace-1",
  runtime: { language: "python" as const, version: "3.12.0" },
  files: [
    { path: "main.py", content: "print(message)\n" },
    { path: "helpers.py", content: "message = 'hello'\n" },
  ],
};

describe("remote Python language-service adapter", () => {
  it("normalizes pinned-runtime initialization, diagnostics, and completion", async () => {
    const connection = new FakeConnection();
    connection.results.set("enkode/python/completions", [
      { label: "message", insertText: "message", kind: "variable" },
    ]);
    const service = new RemotePythonLanguageService(
      "wss://languages.enkode.test/python",
      new FakeTransport(connection),
    );
    const states: string[] = [];
    const diagnostics = vi.fn();
    service.subscribeState((state) => states.push(state.status));
    service.subscribeDiagnostics(diagnostics);

    await service.connect(configuration);
    connection.emitNotification("enkode/python/diagnostics", {
      workspaceId: "workspace-1",
      diagnostics: [{ path: "main.py", message: "Unknown name", severity: "error" }],
    });
    const completions = await service.complete({ path: "main.py", line: 0, column: 5 });

    expect(states).toEqual(["disconnected", "connecting", "ready"]);
    expect(connection.requests[0]).toEqual({
      method: "enkode/python/openWorkspace",
      params: { ...configuration, provider: "pyright", revision: 1 },
    });
    expect(connection.requests[1]).toEqual({
      method: "enkode/python/completions",
      params: { workspaceId: "workspace-1", path: "main.py", line: 0, column: 5 },
    });
    expect(completions).toEqual([{ label: "message", insertText: "message", kind: "variable" }]);
    expect(diagnostics).toHaveBeenCalledWith([
      { path: "main.py", message: "Unknown name", severity: "error" },
    ]);
  });

  it("keeps the latest edits while disconnected and sends a full snapshot on recovery", async () => {
    const first = new FakeConnection();
    const recovered = new FakeConnection();
    const transport = new FakeTransport(first, recovered);
    const service = new RemotePythonLanguageService(
      "wss://languages.enkode.test/python",
      transport,
    );
    await service.connect(configuration);

    first.emitClose("gateway restarted");
    expect(service.getState()).toEqual({ status: "failed", message: "gateway restarted" });
    expect(() => service.updateFile("main.py", "print('still editing')\n")).not.toThrow();

    await service.reconnect();

    expect(service.getState()).toEqual({ status: "ready" });
    expect(recovered.requests[0]).toEqual({
      method: "enkode/python/openWorkspace",
      params: {
        ...configuration,
        provider: "pyright",
        revision: 2,
        files: [{ path: "main.py", content: "print('still editing')\n" }, configuration.files[1]],
      },
    });
  });

  it("contains transport and request failures so editing can continue", async () => {
    const connection = new FakeConnection();
    const transport = new FakeTransport(new Error("service unavailable"), connection);
    const service = new RemotePythonLanguageService(
      "wss://languages.enkode.test/python",
      transport,
    );

    await expect(service.connect(configuration)).resolves.toBeUndefined();
    expect(service.getState()).toEqual({ status: "failed", message: "service unavailable" });
    service.updateFile("helpers.py", "message = 'offline edit'\n");

    await service.reconnect();
    connection.notificationError = new Error("connection lost");
    service.updateFile("helpers.py", "message = 'another edit'\n");
    await vi.waitFor(() => expect(service.getState().status).toBe("failed"));

    expect(connection.notifications).toEqual([
      {
        method: "enkode/python/changeFile",
        params: {
          workspaceId: "workspace-1",
          path: "helpers.py",
          content: "message = 'another edit'\n",
          revision: 3,
        },
      },
    ]);
  });
});

class FakeTransport implements LanguageServiceTransport {
  private readonly outcomes: (FakeConnection | Error)[];

  constructor(...outcomes: (FakeConnection | Error)[]) {
    this.outcomes = outcomes;
  }

  async connect() {
    const outcome = this.outcomes.shift();
    if (!outcome) throw new Error("No fake connection configured");
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

class FakeConnection implements LanguageServiceConnection {
  requests: { method: string; params: unknown }[] = [];
  notifications: { method: string; params: unknown }[] = [];
  results = new Map<string, unknown>();
  notificationError?: Error;
  private notificationListeners = new Set<(method: string, params: unknown) => void>();
  private closeListeners = new Set<(reason?: string) => void>();

  async request<Result>(method: string, params: unknown) {
    this.requests.push({ method, params });
    return this.results.get(method) as Result;
  }

  async notify(method: string, params: unknown) {
    this.notifications.push({ method, params });
    if (this.notificationError) throw this.notificationError;
  }

  onNotification(listener: (method: string, params: unknown) => void) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onClose(listener: (reason?: string) => void) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  emitNotification(method: string, params: unknown) {
    for (const listener of this.notificationListeners) listener(method, params);
  }

  emitClose(reason: string) {
    for (const listener of this.closeListeners) listener(reason);
  }

  dispose() {}
}
