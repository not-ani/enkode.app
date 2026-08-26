export type ReplayFile = { path: string; content: string };

export type ReplayEvent =
  | {
      sequence: number;
      type: "workspace_state";
      files: ReplayFile[];
      observedAt: number;
    }
  | {
      sequence: number;
      type: "file_change";
      path: string;
      changes: { rangeOffset: number; rangeLength: number; text: string }[];
      origin: string;
      observedAt: number;
    };

export type ReplayFrame = {
  sequence: number;
  files: ReplayFile[];
  event: ReplayEvent;
};

function copyFiles(files: ReplayFile[]) {
  const paths = new Set<string>();
  return files.map(({ path, content }) => {
    if (!path || typeof content !== "string" || paths.has(path)) {
      throw new Error("Work History contains an invalid Workspace state");
    }
    paths.add(path);
    return { path, content };
  });
}

/** Reconstructs immutable sequence frames from one independently loadable history page. */
export function reconstructReplayFrames(baseline: ReplayFile[], events: ReplayEvent[]) {
  let files = copyFiles(baseline);
  const frames: ReplayFrame[] = [];

  for (const event of events) {
    if (event.type === "workspace_state") {
      files = copyFiles(event.files);
    } else {
      const fileIndex = files.findIndex(({ path }) => path === event.path);
      if (fileIndex === -1) throw new Error(`Work History references unknown file ${event.path}`);
      let content = files[fileIndex]!.content;
      const changes = [...event.changes].sort(
        (left, right) => right.rangeOffset - left.rangeOffset,
      );
      for (const change of changes) {
        if (
          !Number.isSafeInteger(change.rangeOffset) ||
          !Number.isSafeInteger(change.rangeLength) ||
          change.rangeOffset < 0 ||
          change.rangeLength < 0 ||
          change.rangeOffset + change.rangeLength > content.length ||
          typeof change.text !== "string"
        ) {
          throw new Error("Work History contains an invalid file change");
        }
        content =
          content.slice(0, change.rangeOffset) +
          change.text +
          content.slice(change.rangeOffset + change.rangeLength);
      }
      files = files.map((file, index) =>
        index === fileIndex ? { path: event.path, content } : file,
      );
    }
    frames.push({ sequence: event.sequence, files: copyFiles(files), event });
  }

  return frames;
}

export function sameReplayFiles(left: ReplayFile[], right: ReplayFile[]) {
  return (
    left.length === right.length &&
    left.every(
      (file, index) => file.path === right[index]?.path && file.content === right[index]?.content,
    )
  );
}
