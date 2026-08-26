import type {
  ReplayEvent,
  ReplayFile,
  ReplayFrame,
} from "@enkode.app/backend/convex/workHistoryReplayModel";
import { reconstructReplayFrames } from "@enkode.app/backend/convex/workHistoryReplayModel";
import { Button } from "@enkode.app/ui/components/button";
import { useCallback, useEffect, useRef, useState } from "react";

export type ReplayPage = {
  baselineFiles: ReplayFile[];
  events: ReplayEvent[];
  nextSequence?: number;
};

const originLabels: Record<string, string> = {
  typing: "Typing",
  paste: "Paste",
  completion: "Completion",
  formatting: "Formatting",
  "quick-fix": "Quick fix",
  rename: "Rename",
  undo: "Undo",
  redo: "Redo",
  "assignment-version-merge": "Assignment version merge",
  unattributed: "No observed Edit Origin",
};

export default function WorkHistoryReplay({
  committedThrough,
  loadPage,
}: {
  committedThrough: number;
  loadPage: (afterSequence: number) => Promise<ReplayPage | undefined>;
}) {
  const [frames, setFrames] = useState<ReplayFrame[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activePath, setActivePath] = useState<string>();
  const [nextSequence, setNextSequence] = useState<number | undefined>(
    committedThrough > 0 ? 1 : undefined,
  );
  const [loading, setLoading] = useState(committedThrough > 0);
  const [error, setError] = useState<string>();
  const initialLoadStarted = useRef(false);

  const appendPage = useCallback(
    async (afterSequence: number) => {
      setLoading(true);
      setError(undefined);
      try {
        const page = await loadPage(afterSequence);
        if (!page) {
          setNextSequence(undefined);
          return;
        }
        const nextFrames = reconstructReplayFrames(page.baselineFiles, page.events);
        setFrames((current) => [...current, ...nextFrames]);
        setNextSequence(page.nextSequence);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not load Work History");
      } finally {
        setLoading(false);
      }
    },
    [loadPage],
  );

  useEffect(() => {
    if (committedThrough > 0 && !initialLoadStarted.current) {
      initialLoadStarted.current = true;
      void appendPage(0);
    }
  }, [appendPage, committedThrough]);

  if (committedThrough === 0) {
    return <p className="text-sm text-muted-foreground">No committed Work History yet.</p>;
  }
  if (frames.length === 0) {
    return (
      <p className={error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
        {error ?? "Loading the first Work History segment…"}
      </p>
    );
  }

  const frame = frames[selectedIndex] ?? frames[0]!;
  const selectedPath = frame.files.some(({ path }) => path === activePath)
    ? activePath!
    : frame.files[0]!.path;
  const activeFile = frame.files.find(({ path }) => path === selectedPath)!;
  const origin = frame.event.type === "file_change" ? frame.event.origin : undefined;

  return (
    <section className="flex flex-col gap-4">
      <div className="grid gap-3 border-y border-foreground/10 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium tabular-nums">
              Sequence {frame.sequence} of {committedThrough}
            </p>
            <p className="text-sm text-muted-foreground">
              {frame.event.type === "workspace_state"
                ? "Workspace state"
                : `Edit Origin: ${originLabels[origin!] ?? origin}`}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={selectedIndex === 0}
              onClick={() => setSelectedIndex((index) => Math.max(0, index - 1))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={selectedIndex === frames.length - 1}
              onClick={() => setSelectedIndex((index) => Math.min(frames.length - 1, index + 1))}
            >
              Next
            </Button>
          </div>
        </div>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Replay committed sequence
          <input
            type="range"
            min={0}
            max={frames.length - 1}
            value={selectedIndex}
            onChange={(event) => setSelectedIndex(Number(event.target.value))}
            className="w-full accent-foreground"
          />
        </label>
      </div>

      <div className="grid min-h-[28rem] overflow-hidden border border-foreground/10 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="border-b border-foreground/10 bg-muted/30 lg:border-r lg:border-b-0">
          <p className="px-3 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Files
          </p>
          <div
            role="tablist"
            aria-label="Replay files"
            className="flex overflow-x-auto lg:flex-col"
          >
            {frame.files.map(({ path }) => (
              <button
                type="button"
                role="tab"
                aria-selected={path === selectedPath}
                className="shrink-0 border-l-2 border-transparent px-3 py-2 text-left font-mono text-sm hover:bg-muted aria-selected:border-primary aria-selected:bg-muted"
                onClick={() => setActivePath(path)}
                key={path}
              >
                {path}
              </button>
            ))}
          </div>
        </aside>
        <div className="min-w-0 bg-background">
          <p className="border-b border-foreground/10 px-4 py-3 font-mono text-sm">
            {activeFile.path}
            <span className="ml-2 font-sans text-xs text-muted-foreground">Read only</span>
          </p>
          <pre className="max-h-[36rem] overflow-auto p-4 text-sm leading-6">
            <code>{activeFile.content}</code>
          </pre>
        </div>
      </div>

      {nextSequence !== undefined ? (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          disabled={loading}
          onClick={() => void appendPage(nextSequence - 1)}
        >
          {loading ? "Loading…" : `Load from sequence ${nextSequence}`}
        </Button>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}
