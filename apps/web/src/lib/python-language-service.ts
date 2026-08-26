import {
  RemoteLanguageService,
  type LanguageCompletion,
  type LanguageCompletionRequest,
  type LanguageDiagnostic,
  type LanguageServiceTransport,
  type RemoteLanguageServiceContract,
  type RemoteWorkspaceConfiguration,
} from "./remote-language-service";

export type {
  LanguageIntelligenceState,
  LanguageServiceConnection,
  LanguageServiceTransport,
} from "./remote-language-service";

export type PythonWorkspaceConfiguration = RemoteWorkspaceConfiguration<"python">;
export type PythonDiagnostic = LanguageDiagnostic;
export type PythonCompletion = LanguageCompletion;
export type PythonCompletionRequest = LanguageCompletionRequest;
export type PythonLanguageService = RemoteLanguageServiceContract<"python">;

export class RemotePythonLanguageService extends RemoteLanguageService<"python"> {
  constructor(endpoint: string | undefined, transport: LanguageServiceTransport) {
    super("python", "pyright", endpoint, transport);
  }
}
