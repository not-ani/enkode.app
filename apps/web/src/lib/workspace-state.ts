export type WorkspaceFile = { path: string; content: string };

export type WorkspaceState = {
  activePath: string;
  files: WorkspaceFile[];
};

export type WorkspaceDraft = WorkspaceState & {
  workspaceId: string;
};

export type WorkspaceDraftStore = {
  load: (assignmentReleaseId: string) => WorkspaceDraft | undefined;
  save: (assignmentReleaseId: string, draft: WorkspaceDraft) => void;
  remove: (assignmentReleaseId: string) => void;
};

export function createWorkspaceState(files: WorkspaceFile[], activePath?: string): WorkspaceState {
  if (files.length === 0) throw new Error("A Workspace needs at least one file");
  const selected =
    activePath && files.some(({ path }) => path === activePath) ? activePath : files[0]!.path;
  return { activePath: selected, files };
}

export function editWorkspaceFile(state: WorkspaceState, path: string, content: string) {
  if (!state.files.some((file) => file.path === path)) return state;
  return {
    ...state,
    files: state.files.map((file) => (file.path === path ? { ...file, content } : file)),
  };
}

export function restoreWorkspaceState(
  workspaceId: string,
  remoteFiles: WorkspaceFile[],
  draft: WorkspaceDraft | undefined,
) {
  const compatible = workspaceDraftMatches(workspaceId, remoteFiles, draft);
  return createWorkspaceState(
    compatible ? draft.files : remoteFiles,
    compatible ? draft.activePath : undefined,
  );
}

export function workspaceDraftMatches(
  workspaceId: string,
  remoteFiles: WorkspaceFile[],
  draft: WorkspaceDraft | undefined,
): draft is WorkspaceDraft {
  const remotePaths = remoteFiles.map(({ path }) => path);
  const draftPaths = draft?.files.map(({ path }) => path);
  return (
    draft?.workspaceId === workspaceId &&
    draftPaths?.length === remotePaths.length &&
    remotePaths.every((path, index) => draftPaths[index] === path)
  );
}

export function createLocalWorkspaceDraftStore(storage: Storage): WorkspaceDraftStore {
  const key = (assignmentReleaseId: string) => `enkode.workspace-draft.v1.${assignmentReleaseId}`;
  return {
    load(assignmentReleaseId) {
      const raw = storage.getItem(key(assignmentReleaseId));
      if (!raw) return undefined;
      try {
        return JSON.parse(raw) as WorkspaceDraft;
      } catch {
        storage.removeItem(key(assignmentReleaseId));
        return undefined;
      }
    },
    save(assignmentReleaseId, draft) {
      storage.setItem(key(assignmentReleaseId), JSON.stringify(draft));
    },
    remove(assignmentReleaseId) {
      storage.removeItem(key(assignmentReleaseId));
    },
  };
}
