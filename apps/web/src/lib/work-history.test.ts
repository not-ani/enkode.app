import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMemoryWorkHistoryOutbox,
  createIndexedDbWorkHistoryOutbox,
  editOrigins,
  WorkHistoryRecorder,
  WorkHistorySync,
  type StoredHistoryEvent,
} from "./work-history";

const files = [{ path: "main.py", content: "print('hello')\n" }];

async function eventsIn(bytes: ArrayBuffer) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return ((await new Response(stream).json()) as { events: StoredHistoryEvent[] }).events;
}

async function snapshotIn(bytes: ArrayBuffer) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return (await new Response(stream).json()) as { files: typeof files; sequence: number };
}

async function settleCapture() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Work History capture", () => {
  it("appends Run results without changing the replayed Workspace snapshot", async () => {
    const outbox = createMemoryWorkHistoryOutbox();
    const recorder = new WorkHistoryRecorder(
      "workspace-1",
      outbox,
      () => files,
      () => undefined,
    );
    recorder.start();
    recorder.recordRun({
      runId: "run-1",
      status: "completed",
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
      publicTestResults: [
        { name: "Greets", passed: true, stdout: "hello\n", stderr: "", exitCode: 0 },
      ],
    });
    await settleCapture();
    await recorder.flush();

    const [chunk] = await outbox.chunks("workspace-1");
    expect(await eventsIn(chunk!.bytes)).toEqual([
      expect.objectContaining({ type: "workspace_state", sequence: 1 }),
      expect.objectContaining({
        type: "run",
        sequence: 2,
        runId: "run-1",
        stdout: "hello\n",
        publicTests: [expect.objectContaining({ name: "Greets", passed: true })],
      }),
    ]);
    expect((await snapshotIn(chunk!.snapshotBytes)).files).toEqual(files);
  });

  it("seals the current files and requires durable acknowledgement before Submit", async () => {
    const outbox = createMemoryWorkHistoryOutbox();
    const recorder = new WorkHistoryRecorder(
      "workspace-1",
      outbox,
      () => files,
      () => undefined,
    );
    recorder.start();
    const requiredSequence = await recorder.finalize();
    expect(requiredSequence).toBe(2);
    const offline = new WorkHistorySync("workspace-1", outbox, async () => {
      throw new Error("offline");
    });
    await expect(offline.drainRequired()).rejects.toThrow("offline");
    expect(await outbox.chunks("workspace-1")).toHaveLength(1);

    const online = new WorkHistorySync("workspace-1", outbox, async (chunk) => ({
      acknowledgedThrough: chunk.endSequence,
    }));
    await online.drainRequired();
    expect(await outbox.chunks("workspace-1")).toEqual([]);

    recorder.recordSubmission({
      submissionId: "submission-1",
      attemptNumber: 1,
      proposedPoints: 3,
    });
    await settleCapture();
    await recorder.flush();
    const [submissionChunk] = await outbox.chunks("workspace-1");
    expect(await eventsIn(submissionChunk!.bytes)).toEqual([
      expect.objectContaining({ type: "submission", submissionId: "submission-1", sequence: 3 }),
    ]);
  });

  it("records every observed Edit Origin and preserves unattributed changes honestly", async () => {
    const outbox = createMemoryWorkHistoryOutbox();
    const recorder = new WorkHistoryRecorder(
      "workspace-1",
      outbox,
      () => files,
      () => undefined,
    );
    recorder.start();
    for (const origin of editOrigins) {
      recorder.observeOrigin(origin);
      recorder.recordFileChange("main.py", [{ rangeOffset: 0, rangeLength: 0, text: origin }]);
    }
    recorder.recordFileChange("main.py", [{ rangeOffset: 0, rangeLength: 0, text: "unknown" }]);
    await settleCapture();
    await recorder.flush();

    const [chunk] = await outbox.chunks("workspace-1");
    const events = await eventsIn(chunk!.bytes);
    expect(events[0]).toMatchObject({ type: "workspace_state", sequence: 1 });
    expect(events.slice(1).map((event) => event.type === "file_change" && event.origin)).toEqual([
      ...editOrigins,
      "unattributed",
    ]);
  });

  it("records an accepted Assignment Version merge as a replayable Edit Origin", async () => {
    const mergedFiles = [
      { path: "main.py", content: "print('student')\n" },
      { path: "notes.txt", content: "New starter notes\n" },
    ];
    const outbox = createMemoryWorkHistoryOutbox();
    let currentFiles = files;
    const recorder = new WorkHistoryRecorder(
      "workspace-1",
      outbox,
      () => currentFiles,
      () => undefined,
    );
    recorder.start();
    currentFiles = mergedFiles;
    recorder.recordAssignmentVersionMerge({
      files: mergedFiles,
      fromAssignmentVersionId: "version-1",
      toAssignmentVersionId: "version-2",
      acceptedPaths: ["notes.txt"],
    });
    await settleCapture();
    await recorder.flush();

    const [chunk] = await outbox.chunks("workspace-1");
    const events = await eventsIn(chunk!.bytes);
    expect(events[1]).toMatchObject({
      type: "assignment_version_merge",
      origin: "assignment-version-merge",
      acceptedPaths: ["notes.txt"],
      files: mergedFiles,
    });
    expect((await snapshotIn(chunk!.snapshotBytes)).files).toEqual(mergedFiles);
  });

  it("keeps ordered chunks across an outbox reload and removes only contiguous acknowledgements", async () => {
    const first = createMemoryWorkHistoryOutbox();
    await first.enqueue("workspace-1", {
      type: "workspace_state",
      files,
      observedAt: 1,
    });
    await first.buildNextChunk("workspace-1");
    const reloaded = createMemoryWorkHistoryOutbox(first.state);
    await reloaded.enqueue("workspace-1", {
      type: "file_change",
      path: "main.py",
      changes: [{ rangeOffset: 0, rangeLength: 0, text: "#" }],
      origin: "typing",
      observedAt: 2,
    });
    await reloaded.buildNextChunk("workspace-1");

    expect(
      (await reloaded.chunks("workspace-1")).map((chunk) => [
        chunk.startSequence,
        chunk.endSequence,
      ]),
    ).toEqual([
      [1, 1],
      [2, 2],
    ]);
    await reloaded.acknowledge("workspace-1", 1);
    expect((await reloaded.chunks("workspace-1")).map((chunk) => chunk.startSequence)).toEqual([2]);
  });

  it("recovers queued chunks and its next sequence from IndexedDB after reload", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const first = await createIndexedDbWorkHistoryOutbox("history-reload-test");
    await first.enqueue("workspace-1", {
      type: "workspace_state",
      files,
      observedAt: 1,
    });
    await first.buildNextChunk("workspace-1");

    const reloaded = await createIndexedDbWorkHistoryOutbox("history-reload-test");
    expect((await reloaded.chunks("workspace-1"))[0]).toMatchObject({
      startSequence: 1,
      endSequence: 1,
    });
    expect(
      await reloaded.enqueue("workspace-1", {
        type: "file_change",
        path: "main.py",
        changes: [{ rangeOffset: 0, rangeLength: 0, text: "#" }],
        origin: "typing",
        observedAt: 2,
      }),
    ).toBe(2);
    await reloaded.buildNextChunk("workspace-1");
    expect((await reloaded.chunks("workspace-1")).map((chunk) => chunk.startSequence)).toEqual([
      1, 2,
    ]);
  });

  it("builds each snapshot only through that chunk's final sequence", async () => {
    const outbox = createMemoryWorkHistoryOutbox();
    await outbox.enqueue("workspace-1", {
      type: "workspace_state",
      files: [{ path: "main.py", content: "" }],
      observedAt: 0,
    });
    for (let index = 0; index < 100; index += 1) {
      await outbox.enqueue("workspace-1", {
        type: "file_change",
        path: "main.py",
        changes: [{ rangeOffset: 0, rangeLength: 0, text: "." }],
        origin: "typing",
        observedAt: index + 1,
      });
    }

    const first = await outbox.buildNextChunk("workspace-1");
    const second = await outbox.buildNextChunk("workspace-1");
    expect((await snapshotIn(first!.snapshotBytes)).files[0]?.content).toHaveLength(99);
    expect((await snapshotIn(second!.snapshotBytes)).files[0]?.content).toHaveLength(100);
    expect([first!.endSequence, second!.endSequence]).toEqual([100, 101]);
  });

  it("drains in order and retries without duplicating acknowledged history", async () => {
    const outbox = createMemoryWorkHistoryOutbox();
    await outbox.enqueue("workspace-1", {
      type: "workspace_state",
      files,
      observedAt: 0,
    });
    for (let sequence = 1; sequence <= 2; sequence += 1) {
      await outbox.enqueue("workspace-1", {
        type: "file_change",
        path: "main.py",
        changes: [{ rangeOffset: sequence, rangeLength: 0, text: "." }],
        origin: "typing",
        observedAt: sequence,
      });
      await outbox.buildNextChunk("workspace-1");
    }
    const attempts: number[] = [];
    let fail = true;
    const sync = new WorkHistorySync("workspace-1", outbox, async (chunk) => {
      attempts.push(chunk.startSequence);
      if (fail) {
        fail = false;
        throw new Error("offline");
      }
      return { acknowledgedThrough: chunk.endSequence };
    });

    await sync.drain();
    await sync.drain();
    sync.stop();
    expect(attempts).toEqual([1, 1, 3]);
    expect(await outbox.chunks("workspace-1")).toEqual([]);
  });
});
