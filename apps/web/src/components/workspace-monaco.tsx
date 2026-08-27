import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker?worker";
import "monaco-editor/language/typescript/monaco.contribution";

if (typeof self !== "undefined") {
  self.MonacoEnvironment = {
    getWorker: (_moduleId, label) =>
      label === "typescript" || label === "javascript"
        ? new TypeScriptWorker()
        : new EditorWorker(),
  };
}
loader.config({ monaco });

export default Editor;
