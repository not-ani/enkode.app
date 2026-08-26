import type * as Monaco from "monaco-editor/editor/editor.api";

import type {
  PythonCompletion,
  PythonDiagnostic,
  PythonLanguageService,
} from "./python-language-service";

const markerOwner = "enkode-python";

export function registerPythonMonacoAdapter(
  monaco: typeof Monaco,
  service: PythonLanguageService,
  workspaceId: string,
) {
  const belongsToWorkspace = (model: Monaco.editor.ITextModel) =>
    model.uri.scheme === "enkode" && model.uri.authority === workspaceId;
  const clearMarkers = () => {
    for (const model of monaco.editor.getModels()) {
      if (belongsToWorkspace(model)) monaco.editor.setModelMarkers(model, markerOwner, []);
    }
  };
  const stateSubscription = service.subscribeState((state) => {
    if (state.status !== "ready") clearMarkers();
  });
  const diagnosticSubscription = service.subscribeDiagnostics((diagnostics) => {
    const grouped = new Map<string, PythonDiagnostic[]>();
    for (const diagnostic of diagnostics) {
      const entries = grouped.get(diagnostic.path) ?? [];
      entries.push(diagnostic);
      grouped.set(diagnostic.path, entries);
    }
    for (const model of monaco.editor.getModels()) {
      if (!belongsToWorkspace(model)) continue;
      const path = decodeURIComponent(model.uri.path.replace(/^\//, ""));
      monaco.editor.setModelMarkers(
        model,
        markerOwner,
        (grouped.get(path) ?? []).map((diagnostic) => toMarker(monaco, diagnostic)),
      );
    }
  });
  const completionProvider = monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: ["."],
    async provideCompletionItems(model, position) {
      if (!belongsToWorkspace(model)) return { suggestions: [] };
      const path = decodeURIComponent(model.uri.path.replace(/^\//, ""));
      const completions = await service.complete({
        path,
        line: position.lineNumber - 1,
        column: position.column - 1,
      });
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: position.column,
      };
      return {
        suggestions: completions.map((completion) => ({
          label: completion.label,
          insertText: completion.insertText,
          detail: completion.detail,
          kind: completionKind(monaco, completion),
          range,
        })),
      };
    },
  });

  return {
    dispose() {
      clearMarkers();
      stateSubscription();
      diagnosticSubscription();
      completionProvider.dispose();
    },
  };
}

function toMarker(monaco: typeof Monaco, diagnostic: PythonDiagnostic): Monaco.editor.IMarkerData {
  const severity = {
    error: monaco.MarkerSeverity.Error,
    warning: monaco.MarkerSeverity.Warning,
    information: monaco.MarkerSeverity.Info,
    hint: monaco.MarkerSeverity.Hint,
  }[diagnostic.severity];
  return {
    message: diagnostic.message,
    severity,
    startLineNumber: diagnostic.start.line + 1,
    startColumn: diagnostic.start.column + 1,
    endLineNumber: diagnostic.end.line + 1,
    endColumn: diagnostic.end.column + 1,
  };
}

function completionKind(monaco: typeof Monaco, completion: PythonCompletion) {
  return {
    class: monaco.languages.CompletionItemKind.Class,
    function: monaco.languages.CompletionItemKind.Function,
    keyword: monaco.languages.CompletionItemKind.Keyword,
    method: monaco.languages.CompletionItemKind.Method,
    module: monaco.languages.CompletionItemKind.Module,
    property: monaco.languages.CompletionItemKind.Property,
    variable: monaco.languages.CompletionItemKind.Variable,
  }[completion.kind ?? "variable"];
}
