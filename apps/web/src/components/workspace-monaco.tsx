import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

if (typeof self !== "undefined") {
  self.MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };
}
loader.config({ monaco });

export default Editor;
