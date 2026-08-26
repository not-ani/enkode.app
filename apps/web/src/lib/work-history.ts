import type { WorkspaceFile } from "./workspace-state";

export const editOrigins = [
  "typing",
  "paste",
  "completion",
  "formatting",
  "quick-fix",
  "rename",
  "undo",
  "redo",
  "assignment-version-merge",
] as const;

export type EditOrigin = (typeof editOrigins)[number];

export type FileChange = {
  rangeOffset: number;
  rangeLength: number;
  text: string;
};

export type WorkHistoryEvent =
  | { type: "workspace_state"; files: WorkspaceFile[]; observedAt: number }
  | {
      type: "file_change";
      path: string;
      changes: FileChange[];
      origin: EditOrigin | "unattributed";
      observedAt: number;
    }
  | {
      type: "run";
      runId: string;
      status: "completed" | "failed" | "timed_out";
      stdout: string;
      stderr: string;
      exitCode: number | null;
      publicTests: {
        name: string;
        passed: boolean;
        stdout: string;
        stderr: string;
        exitCode: number | null;
      }[];
      observedAt: number;
    };

export type StoredHistoryEvent = WorkHistoryEvent & { sequence: number };

export type WorkHistoryChunk = {
  workspaceId: string;
  startSequence: number;
  endSequence: number;
  eventCount: number;
  contentHash: string;
  byteLength: number;
  bytes: ArrayBuffer;
  snapshotHash: string;
  snapshotByteLength: number;
  snapshotBytes: ArrayBuffer;
};

export interface WorkHistoryOutbox {
  enqueue(workspaceId: string, event: WorkHistoryEvent): Promise<number>;
  buildNextChunk(workspaceId: string): Promise<WorkHistoryChunk | undefined>;
  chunks(workspaceId: string): Promise<WorkHistoryChunk[]>;
  acknowledge(workspaceId: string, throughSequence: number): Promise<void>;
}

async function gzip(value: unknown) {
  const source = new TextEncoder().encode(JSON.stringify(value));
  const stream = new Blob([source]).stream().pipeThrough(new CompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

async function digest(bytes: ArrayBuffer) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function createChunk(
  workspaceId: string,
  events: StoredHistoryEvent[],
  files: WorkspaceFile[],
) {
  if (events.length === 0) return undefined;
  const bytes = await gzip({ version: 1, workspaceId, events });
  const snapshotBytes = await gzip({
    version: 1,
    workspaceId,
    sequence: events.at(-1)!.sequence,
    files,
  });
  return {
    workspaceId,
    startSequence: events[0]!.sequence,
    endSequence: events.at(-1)!.sequence,
    eventCount: events.length,
    contentHash: await digest(bytes),
    byteLength: bytes.byteLength,
    bytes,
    snapshotHash: await digest(snapshotBytes),
    snapshotByteLength: snapshotBytes.byteLength,
    snapshotBytes,
  } satisfies WorkHistoryChunk;
}

function applyEvents(startingFiles: WorkspaceFile[], events: StoredHistoryEvent[]) {
  let files = startingFiles.map((file) => ({ ...file }));
  for (const event of events) {
    if (event.type === "workspace_state") {
      files = event.files.map((file) => ({ ...file }));
      continue;
    }
    if (event.type === "run") continue;
    files = files.map((file) => {
      if (file.path !== event.path) return file;
      let content = file.content;
      for (const change of [...event.changes].sort(
        (left, right) => right.rangeOffset - left.rangeOffset,
      )) {
        content =
          content.slice(0, change.rangeOffset) +
          change.text +
          content.slice(change.rangeOffset + change.rangeLength);
      }
      return { ...file, content };
    });
  }
  if (files.length === 0) throw new Error("Work History has no workspace-state baseline");
  return files;
}

type MemoryState = {
  next: Map<string, number>;
  events: Map<string, StoredHistoryEvent[]>;
  chunks: Map<string, WorkHistoryChunk[]>;
  snapshots: Map<string, WorkspaceFile[]>;
};

export function createMemoryWorkHistoryOutbox(
  state: MemoryState = {
    next: new Map(),
    events: new Map(),
    chunks: new Map(),
    snapshots: new Map(),
  },
): WorkHistoryOutbox & { state: MemoryState } {
  return {
    state,
    async enqueue(workspaceId, event) {
      const sequence = state.next.get(workspaceId) ?? 1;
      state.next.set(workspaceId, sequence + 1);
      state.events.set(workspaceId, [
        ...(state.events.get(workspaceId) ?? []),
        { ...event, sequence },
      ]);
      return sequence;
    },
    async buildNextChunk(workspaceId) {
      const events = (state.events.get(workspaceId) ?? []).slice(0, 100);
      const files = applyEvents(state.snapshots.get(workspaceId) ?? [], events);
      const chunk = await createChunk(workspaceId, events, files);
      if (!chunk) return undefined;
      state.snapshots.set(workspaceId, files);
      state.events.set(workspaceId, (state.events.get(workspaceId) ?? []).slice(events.length));
      state.chunks.set(workspaceId, [...(state.chunks.get(workspaceId) ?? []), chunk]);
      return chunk;
    },
    async chunks(workspaceId) {
      return [...(state.chunks.get(workspaceId) ?? [])].sort(
        (left, right) => left.startSequence - right.startSequence,
      );
    },
    async acknowledge(workspaceId, throughSequence) {
      state.chunks.set(
        workspaceId,
        (state.chunks.get(workspaceId) ?? []).filter(
          ({ endSequence }) => endSequence > throughSequence,
        ),
      );
    },
  };
}

type PendingRow = StoredHistoryEvent & { workspaceId: string };

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

export async function createIndexedDbWorkHistoryOutbox(
  databaseName = "enkode-work-history-v1",
): Promise<WorkHistoryOutbox> {
  const request = indexedDB.open(databaseName, 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    database.createObjectStore("metadata", { keyPath: "workspaceId" });
    const events = database.createObjectStore("events", {
      keyPath: ["workspaceId", "sequence"],
    });
    events.createIndex("by_workspace", "workspaceId");
    const chunks = database.createObjectStore("chunks", {
      keyPath: ["workspaceId", "startSequence"],
    });
    chunks.createIndex("by_workspace", "workspaceId");
  };
  const database = await requestResult(request);
  let queue = Promise.resolve();

  async function serialized<T>(operation: () => Promise<T>) {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }

  return {
    enqueue: (workspaceId, event) =>
      serialized(async () => {
        const transaction = database.transaction(["metadata", "events"], "readwrite");
        const metadata = transaction.objectStore("metadata");
        const current = (await requestResult(metadata.get(workspaceId))) as
          | { workspaceId: string; nextSequence: number }
          | undefined;
        const sequence = current?.nextSequence ?? 1;
        metadata.put({ ...current, workspaceId, nextSequence: sequence + 1 });
        transaction.objectStore("events").put({ workspaceId, ...event, sequence });
        await transactionDone(transaction);
        return sequence;
      }),
    buildNextChunk: (workspaceId) =>
      serialized(async () => {
        const read = database.transaction(["events", "metadata"], "readonly");
        const [rows, metadata] = await Promise.all([
          requestResult(
            read.objectStore("events").index("by_workspace").getAll(workspaceId, 100),
          ) as Promise<PendingRow[]>,
          requestResult(read.objectStore("metadata").get(workspaceId)) as Promise<
            | { workspaceId: string; nextSequence: number; snapshotFiles?: WorkspaceFile[] }
            | undefined
          >,
        ]);
        await transactionDone(read);
        const files = applyEvents(metadata?.snapshotFiles ?? [], rows);
        const chunk = await createChunk(workspaceId, rows, files);
        if (!chunk) return undefined;
        const write = database.transaction(["events", "chunks", "metadata"], "readwrite");
        for (const { sequence } of rows) {
          write.objectStore("events").delete([workspaceId, sequence]);
        }
        write.objectStore("chunks").add(chunk);
        const metadataStore = write.objectStore("metadata");
        const current = (await requestResult(metadataStore.get(workspaceId))) as {
          workspaceId: string;
          nextSequence: number;
        };
        metadataStore.put({
          ...current,
          snapshotFiles: files,
          snapshotSequence: chunk.endSequence,
        });
        await transactionDone(write);
        return chunk;
      }),
    chunks: (workspaceId) =>
      serialized(async () => {
        const transaction = database.transaction("chunks", "readonly");
        const rows = (await requestResult(
          transaction.objectStore("chunks").index("by_workspace").getAll(workspaceId),
        )) as WorkHistoryChunk[];
        await transactionDone(transaction);
        return rows.sort((left, right) => left.startSequence - right.startSequence);
      }),
    acknowledge: (workspaceId, throughSequence) =>
      serialized(async () => {
        const transaction = database.transaction("chunks", "readwrite");
        const store = transaction.objectStore("chunks");
        const rows = (await requestResult(
          store.index("by_workspace").getAll(workspaceId),
        )) as WorkHistoryChunk[];
        for (const row of rows) {
          if (row.endSequence <= throughSequence) store.delete([workspaceId, row.startSequence]);
        }
        await transactionDone(transaction);
      }),
  };
}

export class WorkHistoryRecorder {
  private origin?: { value: EditOrigin; expiresAt: number };
  private flushTimer?: ReturnType<typeof setTimeout>;
  private flushPromise = Promise.resolve();

  constructor(
    private readonly workspaceId: string,
    private readonly outbox: WorkHistoryOutbox,
    private readonly files: () => WorkspaceFile[],
    private readonly onChunkReady: () => void,
  ) {}

  start() {
    this.capture({ type: "workspace_state", files: this.files(), observedAt: Date.now() });
  }

  observeOrigin(origin: EditOrigin, windowMs = 1_000) {
    this.origin = { value: origin, expiresAt: Date.now() + windowMs };
  }

  clearObservedOrigin(origin: EditOrigin) {
    if (this.origin?.value === origin) this.origin = undefined;
  }

  recordFileChange(path: string, changes: FileChange[], explicitOrigin?: EditOrigin) {
    const observed =
      explicitOrigin ??
      (this.origin && this.origin.expiresAt >= Date.now() ? this.origin.value : undefined);
    this.origin = undefined;
    this.capture({
      type: "file_change",
      path,
      changes,
      origin: observed ?? "unattributed",
      observedAt: Date.now(),
    });
  }

  recordRun(run: {
    runId: string;
    status: "completed" | "failed" | "timed_out";
    stdout: string;
    stderr: string;
    exitCode: number | null;
    publicTestResults: {
      name: string;
      passed: boolean;
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }[];
  }) {
    this.capture({
      type: "run",
      runId: run.runId,
      status: run.status,
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
      publicTests: run.publicTestResults,
      observedAt: Date.now(),
    });
  }

  async flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.flushPromise = this.flushPromise.then(async () => {
      let chunk = await this.outbox.buildNextChunk(this.workspaceId);
      while (chunk) {
        this.onChunkReady();
        chunk = await this.outbox.buildNextChunk(this.workspaceId);
      }
    });
    await this.flushPromise;
  }

  private capture(event: WorkHistoryEvent) {
    void this.outbox.enqueue(this.workspaceId, event).then(() => {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => void this.flush(), 500);
    });
  }
}

export class WorkHistorySync {
  private draining?: Promise<void>;
  private drainRequested = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly online = () => void this.drain();

  constructor(
    private readonly workspaceId: string,
    private readonly outbox: WorkHistoryOutbox,
    private readonly upload: (chunk: WorkHistoryChunk) => Promise<{ acknowledgedThrough: number }>,
  ) {}

  start() {
    this.stopped = false;
    if (typeof window !== "undefined") window.addEventListener("online", this.online);
    void this.drain();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (typeof window !== "undefined") window.removeEventListener("online", this.online);
  }

  drain() {
    if (this.stopped) return Promise.resolve();
    if (this.draining) {
      this.drainRequested = true;
      return this.draining;
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.draining = this.runDrain().finally(() => {
      this.draining = undefined;
      if (this.drainRequested) {
        this.drainRequested = false;
        void this.drain();
      }
    });
    return this.draining;
  }

  private async runDrain() {
    try {
      for (const chunk of await this.outbox.chunks(this.workspaceId)) {
        const { acknowledgedThrough } = await this.upload(chunk);
        if (acknowledgedThrough < chunk.endSequence) {
          throw new Error("Backend acknowledgement is not contiguous through the uploaded chunk");
        }
        await this.outbox.acknowledge(this.workspaceId, acknowledgedThrough);
      }
    } catch {
      if (!this.stopped) this.retryTimer = setTimeout(() => void this.drain(), 2_000);
    }
  }
}
