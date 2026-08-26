import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import type { ReplayEvent, ReplayFile } from "./workHistoryReplayModel";

export type ChunkManifest = {
  workspaceId: string;
  startSequence: number;
  endSequence: number;
  eventCount: number;
  contentHash: string;
  byteLength: number;
  snapshotHash?: string;
  snapshotByteLength?: number;
};

export function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateChunk(manifest: ChunkManifest, bytes: Uint8Array, snapshot?: Uint8Array) {
  if (!Number.isSafeInteger(manifest.startSequence) || manifest.startSequence < 1) {
    throw new Error("Work History sequences start at 1");
  }
  if (
    !Number.isSafeInteger(manifest.endSequence) ||
    manifest.endSequence < manifest.startSequence ||
    manifest.eventCount !== manifest.endSequence - manifest.startSequence + 1
  ) {
    throw new Error("Work History range does not match its event count");
  }
  if (bytes.byteLength !== manifest.byteLength || sha256(bytes) !== manifest.contentHash) {
    throw new Error("Work History chunk hash or length does not match its manifest");
  }
  if (snapshot) {
    if (
      snapshot.byteLength !== manifest.snapshotByteLength ||
      sha256(snapshot) !== manifest.snapshotHash
    ) {
      throw new Error("Work History snapshot hash or length does not match its manifest");
    }
  } else if (manifest.snapshotHash || manifest.snapshotByteLength !== undefined) {
    throw new Error("Work History snapshot bytes are missing");
  }
}

export function decodeSnapshotPayload(manifest: ChunkManifest, snapshot: Uint8Array) {
  if (
    snapshot.byteLength !== manifest.snapshotByteLength ||
    sha256(snapshot) !== manifest.snapshotHash
  ) {
    throw new Error("Work History snapshot hash or length does not match its manifest");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(gunzipSync(snapshot).toString("utf8"));
  } catch {
    throw new Error("Work History snapshot is not valid gzip JSON");
  }
  const candidate = payload as {
    version?: unknown;
    workspaceId?: unknown;
    sequence?: unknown;
    files?: unknown;
  };
  if (
    candidate.version !== 1 ||
    candidate.workspaceId !== manifest.workspaceId ||
    candidate.sequence !== manifest.endSequence ||
    !Array.isArray(candidate.files)
  ) {
    throw new Error("Work History snapshot does not match its manifest");
  }
  return { sequence: candidate.sequence, files: candidate.files as ReplayFile[] };
}

const origins = new Set([
  "typing",
  "paste",
  "completion",
  "formatting",
  "quick-fix",
  "rename",
  "undo",
  "redo",
  "assignment-version-merge",
  "unattributed",
]);

export function validateChunkPayload(
  manifest: ChunkManifest,
  bytes: Uint8Array,
  snapshot?: Uint8Array,
) {
  validateChunk(manifest, bytes, snapshot);
  let payload: unknown;
  try {
    payload = JSON.parse(gunzipSync(bytes).toString("utf8"));
  } catch {
    throw new Error("Work History chunk is not valid gzip JSON");
  }
  if (!payload || typeof payload !== "object") throw new Error("Invalid Work History payload");
  const candidate = payload as { version?: unknown; workspaceId?: unknown; events?: unknown };
  if (
    candidate.version !== 1 ||
    candidate.workspaceId !== manifest.workspaceId ||
    !Array.isArray(candidate.events) ||
    candidate.events.length !== manifest.eventCount
  ) {
    throw new Error("Work History payload does not match its manifest");
  }
  for (const [index, event] of candidate.events.entries()) {
    const expectedSequence = manifest.startSequence + index;
    if (!event || typeof event !== "object") throw new Error("Invalid Work History event");
    const record = event as { sequence?: unknown; type?: unknown; origin?: unknown };
    if (record.sequence !== expectedSequence) {
      throw new Error("Work History payload contains a missing or reordered sequence");
    }
    if (record.type === "file_change" && !origins.has(String(record.origin))) {
      throw new Error("Work History file change needs an observed or unattributed origin");
    }
    if (
      record.type !== "file_change" &&
      record.type !== "workspace_state" &&
      record.type !== "run" &&
      record.type !== "submission"
    ) {
      throw new Error("Invalid Work History event type");
    }
  }
  let decodedSnapshot: { sequence: number; files: ReplayFile[] } | undefined;
  if (snapshot) {
    decodedSnapshot = decodeSnapshotPayload(manifest, snapshot);
  }
  return { events: candidate.events as ReplayEvent[], snapshot: decodedSnapshot };
}

export function objectKeys(organizationId: string, manifest: ChunkManifest) {
  const base = `organizations/${organizationId}/workspaces/${manifest.workspaceId}`;
  const range = `${manifest.startSequence}-${manifest.endSequence}`;
  return {
    chunk: `${base}/history/${range}-${manifest.contentHash}.json.gz`,
    snapshot: manifest.snapshotHash
      ? `${base}/snapshots/${manifest.endSequence}-${manifest.snapshotHash}.json.gz`
      : undefined,
  };
}
