import type * as Monaco from "monaco-editor/editor/editor.api";

import type { LanguageIntelligenceState, PythonLanguageService } from "./python-language-service";
import { registerPythonMonacoAdapter } from "./python-monaco-adapter";

export type WorkspaceLanguage = "python" | "javascript" | "typescript";

export type WorkspaceLanguageService = {
  getState: () => LanguageIntelligenceState;
  subscribeState: (listener: (state: LanguageIntelligenceState) => void) => () => void;
  connect: (configuration: {
    workspaceId: string;
    runtime: { language: WorkspaceLanguage; version: string };
    files: { path: string; content: string }[];
  }) => Promise<void>;
  reconnect: () => Promise<void>;
  updateFile: (path: string, content: string) => void;
  disconnect: () => void;
};

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

  async connect() {
    this.setReady();
  }

  async reconnect() {
    this.setReady();
  }

  updateFile() {}

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
  if (input.language === "python") {
    return registerPythonMonacoAdapter(
      monaco,
      input.service as unknown as PythonLanguageService,
      input.workspaceId,
    );
  }

  const typescript = (monaco as unknown as typeof import("monaco-editor")).languages.typescript;
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

export function languageLabel(language: WorkspaceLanguage) {
  return { python: "Python", javascript: "JavaScript", typescript: "TypeScript" }[language];
}
