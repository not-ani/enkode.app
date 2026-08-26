import { describe, expect, it } from "vitest";

import {
  createLocalWorkspaceDraftStore,
  createWorkspaceState,
  editWorkspaceFile,
  restoreWorkspaceState,
} from "./workspace-state";

const files = [
  { path: "main.py", content: "print(message)\n" },
  { path: "helpers.py", content: "message = 'hello'\n" },
];

describe("Workspace client state", () => {
  it("initializes every starter file with the entrypoint active", () => {
    expect(createWorkspaceState(files, "main.py")).toEqual({ activePath: "main.py", files });
  });

  it("switches and edits files without discarding another Monaco model's content", () => {
    const mainEdited = editWorkspaceFile(createWorkspaceState(files), "main.py", "print('hi')\n");
    const switched = { ...mainEdited, activePath: "helpers.py" };
    const bothEdited = editWorkspaceFile(switched, "helpers.py", "message = 'hi'\n");

    expect(bothEdited).toEqual({
      activePath: "helpers.py",
      files: [
        { path: "main.py", content: "print('hi')\n" },
        { path: "helpers.py", content: "message = 'hi'\n" },
      ],
    });
  });

  it("restores a compatible local draft after navigation or reload", () => {
    const values = new Map<string, string>();
    const storage = {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => {
        values.delete(key);
      },
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    } satisfies Storage;
    const store = createLocalWorkspaceDraftStore(storage);
    const state = editWorkspaceFile(
      createWorkspaceState(files, "helpers.py"),
      "helpers.py",
      "message = 'draft'\n",
    );
    store.save("release-1", { workspaceId: "workspace-1", ...state });

    expect(restoreWorkspaceState("workspace-1", files, store.load("release-1"))).toEqual(state);
    expect(restoreWorkspaceState("workspace-2", files, store.load("release-1"))).toEqual(
      createWorkspaceState(files),
    );
  });
});
