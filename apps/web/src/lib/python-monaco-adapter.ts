import type * as Monaco from "monaco-editor/editor/editor.api";

import type { PythonLanguageService } from "./python-language-service";
import { registerRemoteMonacoAdapter } from "./remote-monaco-adapter";

export function registerPythonMonacoAdapter(
  monaco: typeof Monaco,
  service: PythonLanguageService,
  workspaceId: string,
) {
  return registerRemoteMonacoAdapter(monaco, service, workspaceId, "python");
}
