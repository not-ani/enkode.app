import type * as Monaco from "monaco-editor/editor/editor.api";

import type {
  LanguageCompletion,
  LanguageCompletionRequest,
  LanguageDiagnostic,
  LanguageIntelligenceState,
} from "./remote-language-service";
import { registerRemoteMonacoAdapter } from "./remote-monaco-adapter";

export type WorkspaceLanguage = "python" | "javascript" | "typescript" | "java";

export interface WorkspaceLanguageService {
  getState(): LanguageIntelligenceState;
  subscribeState(listener: (state: LanguageIntelligenceState) => void): () => void;
  subscribeDiagnostics(listener: (diagnostics: LanguageDiagnostic[]) => void): () => void;
  connect(configuration: {
    workspaceId: string;
    runtime: { language: WorkspaceLanguage; version: string };
    files: { path: string; content: string }[];
  }): Promise<void>;
  reconnect(): Promise<void>;
  updateFile(path: string, content: string): void;
  complete(request: LanguageCompletionRequest): Promise<LanguageCompletion[]>;
  disconnect(): void;
}

/** Browser-local intelligence lifecycle behind the same Workspace-facing contract as remote LSPs. */
export class BrowserLocalLanguageService implements WorkspaceLanguageService {
  private state: LanguageIntelligenceState = { status: "ready" };
  private listeners = new Set<(state: LanguageIntelligenceState) => void>();

  constructor(readonly language: "javascript" | "typescript") {}

  getState() {
    return this.state;
  }

  subscribeState(listener: (state: LanguageIntelligenceState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  subscribeDiagnostics(_listener: (diagnostics: LanguageDiagnostic[]) => void) {
    return () => undefined;
  }

  async connect(_configuration: {
    workspaceId: string;
    runtime: { language: WorkspaceLanguage; version: string };
    files: { path: string; content: string }[];
  }) {
    this.setReady();
  }

  async reconnect() {
    this.setReady();
  }

  updateFile(_path: string, _content: string) {}

  async complete(_request: LanguageCompletionRequest) {
    return [];
  }

  disconnect() {}

  private setReady() {
    this.state = { status: "ready" };
    for (const listener of this.listeners) listener(this.state);
  }
}

export function registerEnkodeMonacoLanguageAdapter(
  monaco: typeof Monaco,
  input: {
    language: WorkspaceLanguage;
    service: WorkspaceLanguageService;
    workspaceId: string;
  },
) {
  if (input.language === "python" || input.language === "java") {
    return registerRemoteMonacoAdapter(monaco, input.service, input.workspaceId, input.language);
  }

  const typescript = (
    monaco.languages as unknown as {
      typescript: {
        typescriptDefaults: TypeScriptDefaults;
        javascriptDefaults: TypeScriptDefaults;
        ModuleKind: { ESNext: number };
        ModuleResolutionKind: { NodeJs: number };
        ScriptTarget: { ES2022: number };
      };
    }
  ).typescript;
  const defaults =
    input.language === "typescript" ? typescript.typescriptDefaults : typescript.javascriptDefaults;
  defaults.setEagerModelSync(true);
  defaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false });
  defaults.setCompilerOptions({
    allowNonTsExtensions: true,
    allowJs: input.language === "javascript",
    checkJs: input.language === "javascript",
    module: typescript.ModuleKind.ESNext,
    moduleResolution: typescript.ModuleResolutionKind.NodeJs,
    target: typescript.ScriptTarget.ES2022,
  });

  return { dispose() {} };
}

type TypeScriptDefaults = {
  setEagerModelSync(value: boolean): void;
  setDiagnosticsOptions(options: {
    noSemanticValidation: boolean;
    noSyntaxValidation: boolean;
  }): void;
  setCompilerOptions(options: {
    allowNonTsExtensions: boolean;
    allowJs: boolean;
    checkJs: boolean;
    module: number;
    moduleResolution: number;
    target: number;
  }): void;
};

export function languageLabel(language: WorkspaceLanguage) {
  return { python: "Python", javascript: "JavaScript", typescript: "TypeScript", java: "Java" }[
    language
  ];
}
