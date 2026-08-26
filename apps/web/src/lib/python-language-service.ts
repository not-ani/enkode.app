export type LanguageIntelligenceState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "ready" }
  | { status: "failed"; message: string };

export type PythonWorkspaceConfiguration = {
  workspaceId: string;
  runtime: { language: "python"; version: string };
  files: { path: string; content: string }[];
};

export type PythonDiagnostic = {
  path: string;
  message: string;
  severity: "error" | "warning" | "information" | "hint";
  start: { line: number; column: number };
  end: { line: number; column: number };
};

export type PythonCompletion = {
  label: string;
  insertText: string;
  detail?: string;
  kind?: "class" | "function" | "keyword" | "method" | "module" | "property" | "variable";
};

export type PythonCompletionRequest = {
  path: string;
  line: number;
  column: number;
};

export type LanguageServiceConnection = {
  request: <Result>(method: string, params: unknown) => Promise<Result>;
  notify: (method: string, params: unknown) => Promise<void>;
  onNotification: (listener: (method: string, params: unknown) => void) => () => void;
  onClose: (listener: (reason?: string) => void) => () => void;
  dispose: () => void;
};

export type LanguageServiceTransport = {
  connect: (endpoint: string) => Promise<LanguageServiceConnection>;
};

export type PythonLanguageService = {
  getState: () => LanguageIntelligenceState;
  subscribeState: (listener: (state: LanguageIntelligenceState) => void) => () => void;
  subscribeDiagnostics: (listener: (diagnostics: PythonDiagnostic[]) => void) => () => void;
  connect: (configuration: PythonWorkspaceConfiguration) => Promise<void>;
  reconnect: () => Promise<void>;
  updateFile: (path: string, content: string) => void;
  complete: (request: PythonCompletionRequest) => Promise<PythonCompletion[]>;
  disconnect: () => void;
};

type WorkspaceSnapshot = PythonWorkspaceConfiguration & {
  provider: "pyright";
  revision: number;
};

/**
 * Owns the protocol Monaco uses for Python intelligence. The remote gateway may use Pyright
 * internally, but provider-specific messages and lifecycle never escape this adapter.
 */
export class RemotePythonLanguageService implements PythonLanguageService {
  private state: LanguageIntelligenceState = { status: "disconnected" };
  private configuration?: PythonWorkspaceConfiguration;
  private revision = 0;
  private generation = 0;
  private connection?: LanguageServiceConnection;
  private stateListeners = new Set<(state: LanguageIntelligenceState) => void>();
  private diagnosticListeners = new Set<(diagnostics: PythonDiagnostic[]) => void>();

  constructor(
    private readonly endpoint: string | undefined,
    private readonly transport: LanguageServiceTransport,
  ) {}

  getState() {
    return this.state;
  }

  subscribeState(listener: (state: LanguageIntelligenceState) => void) {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  subscribeDiagnostics(listener: (diagnostics: PythonDiagnostic[]) => void) {
    this.diagnosticListeners.add(listener);
    return () => {
      this.diagnosticListeners.delete(listener);
    };
  }

  async connect(configuration: PythonWorkspaceConfiguration) {
    this.configuration = cloneConfiguration(configuration);
    this.revision += 1;
    await this.openCurrentWorkspace();
  }

  async reconnect() {
    if (!this.configuration) return;
    await this.openCurrentWorkspace();
  }

  updateFile(path: string, content: string) {
    const file = this.configuration?.files.find((candidate) => candidate.path === path);
    if (!file || file.content === content) return;
    file.content = content;
    this.revision += 1;

    if (this.state.status !== "ready" || !this.connection) return;
    const connection = this.connection;
    const change = {
      workspaceId: this.configuration.workspaceId,
      path,
      content,
      revision: this.revision,
    };
    void Promise.resolve()
      .then(() => connection.notify("enkode/python/changeFile", change))
      .catch((error: unknown) => this.failConnection(connection, error));
  }

  async complete(request: PythonCompletionRequest) {
    const connection = this.connection;
    if (this.state.status !== "ready" || !connection || !this.configuration) return [];
    try {
      return await connection.request<PythonCompletion[]>("enkode/python/completions", {
        workspaceId: this.configuration.workspaceId,
        ...request,
      });
    } catch (error) {
      this.failConnection(connection, error);
      return [];
    }
  }

  disconnect() {
    this.generation += 1;
    this.disposeConnection();
    this.setState({ status: "disconnected" });
  }

  private async openCurrentWorkspace() {
    const configuration = this.configuration;
    if (!configuration) return;
    const generation = ++this.generation;
    this.disposeConnection();
    this.setState({ status: "connecting" });

    if (!this.endpoint) {
      this.setState({ status: "failed", message: "Python intelligence is not configured" });
      return;
    }

    try {
      const connection = await this.transport.connect(this.endpoint);
      if (generation !== this.generation) {
        connection.dispose();
        return;
      }
      this.connection = connection;
      connection.onNotification((method, params) => {
        if (generation !== this.generation || method !== "enkode/python/diagnostics") return;
        const diagnostics = params as { workspaceId?: string; diagnostics?: PythonDiagnostic[] };
        if (diagnostics.workspaceId !== this.configuration?.workspaceId) return;
        for (const listener of this.diagnosticListeners) listener(diagnostics.diagnostics ?? []);
      });
      connection.onClose((reason) => {
        if (generation !== this.generation || connection !== this.connection) return;
        this.connection = undefined;
        this.setState({ status: "failed", message: reason ?? "Python intelligence disconnected" });
      });

      let synchronizedRevision = -1;
      while (synchronizedRevision !== this.revision) {
        const snapshot = this.snapshot();
        await connection.request("enkode/python/openWorkspace", snapshot);
        synchronizedRevision = snapshot.revision;
      }
      if (generation === this.generation) this.setState({ status: "ready" });
    } catch (error) {
      if (generation === this.generation) this.failConnection(this.connection, error);
    }
  }

  private snapshot(): WorkspaceSnapshot {
    return {
      ...cloneConfiguration(this.configuration!),
      provider: "pyright",
      revision: this.revision,
    };
  }

  private failConnection(connection: LanguageServiceConnection | undefined, error: unknown) {
    if (connection && connection !== this.connection) return;
    this.disposeConnection();
    this.setState({
      status: "failed",
      message: error instanceof Error ? error.message : "Python intelligence is unavailable",
    });
  }

  private disposeConnection() {
    const connection = this.connection;
    this.connection = undefined;
    connection?.dispose();
  }

  private setState(state: LanguageIntelligenceState) {
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }
}

function cloneConfiguration(configuration: PythonWorkspaceConfiguration) {
  return {
    ...configuration,
    runtime: { ...configuration.runtime },
    files: configuration.files.map((file) => ({ ...file })),
  };
}
