export type LanguageIntelligenceState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | { status: "ready" }
  | { status: "failed"; message: string };

export type RemoteLanguage = "python" | "java";
export type RemoteLanguageProvider = "pyright" | "jdtls";

export type RemoteWorkspaceConfiguration<Language extends RemoteLanguage = RemoteLanguage> = {
  workspaceId: string;
  runtime: { language: Language; version: string };
  files: { path: string; content: string }[];
};

export type LanguageDiagnostic = {
  path: string;
  message: string;
  severity: "error" | "warning" | "information" | "hint";
  start: { line: number; column: number };
  end: { line: number; column: number };
};

export type LanguageCompletion = {
  label: string;
  insertText: string;
  detail?: string;
  kind?: "class" | "function" | "keyword" | "method" | "module" | "property" | "variable";
};

export type LanguageCompletionRequest = { path: string; line: number; column: number };

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

export type RemoteLanguageServiceContract<Language extends RemoteLanguage = RemoteLanguage> = {
  getState: () => LanguageIntelligenceState;
  subscribeState: (listener: (state: LanguageIntelligenceState) => void) => () => void;
  subscribeDiagnostics: (listener: (diagnostics: LanguageDiagnostic[]) => void) => () => void;
  connect: (configuration: RemoteWorkspaceConfiguration<Language>) => Promise<void>;
  reconnect: () => Promise<void>;
  updateFile: (path: string, content: string) => void;
  complete: (request: LanguageCompletionRequest) => Promise<LanguageCompletion[]>;
  disconnect: () => void;
};

type WorkspaceSnapshot<Language extends RemoteLanguage> = RemoteWorkspaceConfiguration<Language> & {
  provider: RemoteLanguageProvider;
  revision: number;
};

/** Keeps Monaco isolated from provider transports while preserving edits across disconnects. */
export class RemoteLanguageService<
  Language extends RemoteLanguage,
> implements RemoteLanguageServiceContract<Language> {
  private state: LanguageIntelligenceState = { status: "disconnected" };
  private configuration?: RemoteWorkspaceConfiguration<Language>;
  private revision = 0;
  private generation = 0;
  private connection?: LanguageServiceConnection;
  private stateListeners = new Set<(state: LanguageIntelligenceState) => void>();
  private diagnosticListeners = new Set<(diagnostics: LanguageDiagnostic[]) => void>();

  constructor(
    private readonly language: Language,
    private readonly provider: RemoteLanguageProvider,
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

  subscribeDiagnostics(listener: (diagnostics: LanguageDiagnostic[]) => void) {
    this.diagnosticListeners.add(listener);
    return () => {
      this.diagnosticListeners.delete(listener);
    };
  }

  async connect(configuration: RemoteWorkspaceConfiguration<Language>) {
    this.configuration = cloneConfiguration(configuration);
    this.revision += 1;
    await this.openCurrentWorkspace();
  }

  async reconnect() {
    if (this.configuration) await this.openCurrentWorkspace();
  }

  updateFile(path: string, content: string) {
    const configuration = this.configuration;
    if (!configuration) return;
    const file = configuration.files.find((candidate) => candidate.path === path);
    if (!file || file.content === content) return;
    file.content = content;
    this.revision += 1;
    if (this.state.status !== "ready" || !this.connection) return;
    const connection = this.connection;
    void connection
      .notify(`enkode/${this.language}/changeFile`, {
        workspaceId: configuration.workspaceId,
        path,
        content,
        revision: this.revision,
      })
      .catch((error: unknown) => this.failConnection(connection, error));
  }

  async complete(request: LanguageCompletionRequest) {
    const connection = this.connection;
    if (this.state.status !== "ready" || !connection || !this.configuration) return [];
    try {
      return await connection.request<LanguageCompletion[]>(`enkode/${this.language}/completions`, {
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
    const name = this.language === "java" ? "Java" : "Python";
    if (!this.endpoint) {
      this.setState({ status: "failed", message: `${name} intelligence is not configured` });
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
        if (generation !== this.generation || method !== `enkode/${this.language}/diagnostics`)
          return;
        const notification = params as {
          workspaceId?: string;
          diagnostics?: LanguageDiagnostic[];
        };
        if (notification.workspaceId !== this.configuration?.workspaceId) return;
        for (const listener of this.diagnosticListeners) listener(notification.diagnostics ?? []);
      });
      connection.onClose((reason) => {
        if (generation !== this.generation || connection !== this.connection) return;
        this.connection = undefined;
        this.setState({ status: "failed", message: reason ?? `${name} intelligence disconnected` });
      });
      let synchronizedRevision = -1;
      while (synchronizedRevision !== this.revision) {
        const snapshot = this.snapshot();
        await connection.request(`enkode/${this.language}/openWorkspace`, snapshot);
        synchronizedRevision = snapshot.revision;
      }
      if (generation === this.generation) this.setState({ status: "ready" });
    } catch (error) {
      if (generation === this.generation) this.failConnection(this.connection, error);
    }
  }

  private snapshot(): WorkspaceSnapshot<Language> {
    return {
      ...cloneConfiguration(this.configuration!),
      provider: this.provider,
      revision: this.revision,
    };
  }

  private failConnection(connection: LanguageServiceConnection | undefined, error: unknown) {
    if (connection && connection !== this.connection) return;
    this.disposeConnection();
    const name = this.language === "java" ? "Java" : "Python";
    this.setState({
      status: "failed",
      message: error instanceof Error ? error.message : `${name} intelligence is unavailable`,
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

function cloneConfiguration<Language extends RemoteLanguage>(
  configuration: RemoteWorkspaceConfiguration<Language>,
) {
  return {
    ...configuration,
    runtime: { ...configuration.runtime },
    files: configuration.files.map((file) => ({ ...file })),
  };
}
