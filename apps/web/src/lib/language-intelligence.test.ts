// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

const defaults = vi.hoisted(() => ({
  javascript: {
    setEagerModelSync: vi.fn(),
    setDiagnosticsOptions: vi.fn(),
    setCompilerOptions: vi.fn(),
  },
  typescript: {
    setEagerModelSync: vi.fn(),
    setDiagnosticsOptions: vi.fn(),
    setCompilerOptions: vi.fn(),
  },
}));

vi.mock("monaco-editor", () => ({
  languages: {
    typescript: {
      javascriptDefaults: defaults.javascript,
      typescriptDefaults: defaults.typescript,
      ModuleKind: { ESNext: 99 },
      ModuleResolutionKind: { NodeJs: 2 },
      ScriptTarget: { ES2022: 9 },
    },
  },
}));

import {
  BrowserLocalLanguageService,
  registerEnkodeMonacoLanguageAdapter,
} from "./language-intelligence";

describe("Enkode browser-local JavaScript and TypeScript intelligence", () => {
  it.each(["javascript", "typescript"] as const)(
    "keeps %s ready without history or remote connectivity",
    async (language) => {
      const service = new BrowserLocalLanguageService(language);
      const states: string[] = [];
      service.subscribeState((state) => states.push(state.status));

      await service.connect({
        workspaceId: "workspace-1",
        runtime: { language, version: language === "javascript" ? "22.14.0" : "5.0.3" },
        files: [{ path: language === "javascript" ? "main.js" : "main.ts", content: "" }],
      });
      service.updateFile("main", "const answer = 42");

      expect(service.getState()).toEqual({ status: "ready" });
      expect(states).toEqual(["ready", "ready"]);
    },
  );

  it.each(["javascript", "typescript"] as const)(
    "configures Monaco's local %s worker through the common adapter",
    (language) => {
      const service = new BrowserLocalLanguageService(language);
      const disposable = registerEnkodeMonacoLanguageAdapter(
        {
          languages: {
            typescript: {
              javascriptDefaults: defaults.javascript,
              typescriptDefaults: defaults.typescript,
              ModuleKind: { ESNext: 99 },
              ModuleResolutionKind: { NodeJs: 2 },
              ScriptTarget: { ES2022: 9 },
            },
          },
        } as never,
        {
          language,
          service,
          workspaceId: "workspace-1",
        },
      );
      const configured = defaults[language];

      expect(configured.setEagerModelSync).toHaveBeenCalledWith(true);
      expect(configured.setDiagnosticsOptions).toHaveBeenCalledWith({
        noSemanticValidation: false,
        noSyntaxValidation: false,
      });
      expect(configured.setCompilerOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          allowJs: language === "javascript",
          checkJs: language === "javascript",
        }),
      );
      expect(() => disposable.dispose()).not.toThrow();
    },
  );
});
