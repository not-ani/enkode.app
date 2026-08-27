import { describe, expect, it, vi } from "vitest";

import { RemoteJavaLanguageService } from "./java-language-service";
import type {
  LanguageServiceConnection,
  LanguageServiceTransport,
} from "./remote-language-service";

const configuration = {
  workspaceId: "workspace-java",
  runtime: { language: "java" as const, version: "15.0.2" },
  files: [{ path: "Main.java", content: "public class Main {}\n" }],
};

describe("remote Java language-service adapter", () => {
  it("normalizes JDT LS initialization, diagnostics, and completion", async () => {
    const connection = new FakeConnection();
    connection.results.set("enkode/java/completions", [
      { label: "println", insertText: "println", kind: "method" },
    ]);
    const service = new RemoteJavaLanguageService(
      "wss://languages.enkode.test/java",
      new FakeTransport(connection),
    );
    const diagnostics = vi.fn();
    service.subscribeDiagnostics(diagnostics);

    await service.connect(configuration);
    connection.emitNotification("enkode/java/diagnostics", {
      workspaceId: configuration.workspaceId,
      diagnostics: [{ path: "Main.java", message: "Syntax error", severity: "error" }],
    });
    const completions = await service.complete({ path: "Main.java", line: 0, column: 10 });

    expect(connection.requests).toEqual([
      {
        method: "enkode/java/openWorkspace",
        params: { ...configuration, provider: "jdtls", revision: 1 },
      },
      {
        method: "enkode/java/completions",
        params: { workspaceId: configuration.workspaceId, path: "Main.java", line: 0, column: 10 },
      },
    ]);
    expect(completions).toEqual([{ label: "println", insertText: "println", kind: "method" }]);
    expect(diagnostics).toHaveBeenCalledWith([
      { path: "Main.java", message: "Syntax error", severity: "error" },
    ]);
  });

  it("contains JDT LS failure, retains edits, and resynchronizes on recovery", async () => {
    const first = new FakeConnection();
    const recovered = new FakeConnection();
    const service = new RemoteJavaLanguageService(
      "wss://languages.enkode.test/java",
      new FakeTransport(first, recovered),
    );
    await service.connect(configuration);

    first.emitClose("JDT LS restarted");
    expect(service.getState()).toEqual({ status: "failed", message: "JDT LS restarted" });
    expect(() =>
      service.updateFile("Main.java", "public class Main { int answer = 42; }\n"),
    ).not.toThrow();

    await service.reconnect();

    expect(service.getState()).toEqual({ status: "ready" });
    expect(recovered.requests[0]).toEqual({
      method: "enkode/java/openWorkspace",
      params: {
        ...configuration,
        provider: "jdtls",
        revision: 2,
        files: [{ path: "Main.java", content: "public class Main { int answer = 42; }\n" }],
      },
    });
  });
});

class FakeTransport implements LanguageServiceTransport {
  private readonly connections: FakeConnection[];

  constructor(...connections: FakeConnection[]) {
    this.connections = connections;
  }

  async connect() {
    const connection = this.connections.shift();
    if (!connection) throw new Error("No fake connection configured");
    return connection;
  }
}

class FakeConnection implements LanguageServiceConnection {
  requests: { method: string; params: unknown }[] = [];
  results = new Map<string, unknown>();
  private notificationListeners = new Set<(method: string, params: unknown) => void>();
  private closeListeners = new Set<(reason?: string) => void>();

  async request<Result>(method: string, params: unknown) {
    this.requests.push({ method, params });
    return this.results.get(method) as Result;
  }

  async notify() {}

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
