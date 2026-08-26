import {
  RemoteLanguageService,
  type LanguageCompletion,
  type LanguageCompletionRequest,
  type LanguageDiagnostic,
  type LanguageServiceTransport,
  type RemoteLanguageServiceContract,
  type RemoteWorkspaceConfiguration,
} from "./remote-language-service";

export type JavaWorkspaceConfiguration = RemoteWorkspaceConfiguration<"java">;
export type JavaDiagnostic = LanguageDiagnostic;
export type JavaCompletion = LanguageCompletion;
export type JavaCompletionRequest = LanguageCompletionRequest;
export type JavaLanguageService = RemoteLanguageServiceContract<"java">;

export class RemoteJavaLanguageService extends RemoteLanguageService<"java"> {
  constructor(endpoint: string | undefined, transport: LanguageServiceTransport) {
    super("java", "jdtls", endpoint, transport);
  }
}
