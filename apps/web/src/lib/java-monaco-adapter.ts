import type * as Monaco from "monaco-editor/editor/editor.api";

import type { JavaLanguageService } from "./java-language-service";
import { registerRemoteMonacoAdapter } from "./remote-monaco-adapter";

export function registerJavaMonacoAdapter(
  monaco: typeof Monaco,
  service: JavaLanguageService,
  workspaceId: string,
) {
  return registerRemoteMonacoAdapter(monaco, service, workspaceId, "java");
}
