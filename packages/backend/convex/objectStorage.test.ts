import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";

import { FakeObjectStorage, S3CompatibleObjectStorage } from "./objectStorage";
import { objectKeys, sha256, validateChunk, validateChunkPayload } from "./workHistoryProtocol";

describe("Work History object storage contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stores content-addressed immutable objects idempotently", async () => {
    const storage = new FakeObjectStorage();
    const bytes = new TextEncoder().encode("compressed history");
    const hash = sha256(bytes);
    const object = {
      key: `history/${hash}.gz`,
      bytes,
      contentType: "application/gzip",
      sha256: hash,
    };

    await storage.putImmutable(object);
    await storage.putImmutable(object);
    expect(storage.objects).toHaveLength(1);
    await expect(
      storage.getImmutable({
        key: object.key,
        sha256: object.sha256,
        byteLength: bytes.byteLength,
      }),
    ).resolves.toEqual(bytes);
    const differentBytes = new TextEncoder().encode("different compressed history");
    await expect(
      storage.putImmutable({
        ...object,
        bytes: differentBytes,
        sha256: sha256(differentBytes),
      }),
    ).rejects.toThrow("different bytes");
  });

  it("reads and verifies immutable bytes through a signed S3 request", async () => {
    const bytes = new TextEncoder().encode("history");
    const fetch = vi.fn(
      async (_input: URL | RequestInfo, _init?: RequestInit) =>
        new Response(bytes, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    const storage = new S3CompatibleObjectStorage({
      endpoint: "https://objects.example.test",
      bucket: "enkode",
      region: "us-east-1",
      accessKeyId: "access",
      secretAccessKey: "secret",
    });

    await expect(
      storage.getImmutable({
        key: "organizations/org/workspaces/ws/history/1-1.json.gz",
        sha256: sha256(bytes),
        byteLength: bytes.byteLength,
      }),
    ).resolves.toEqual(bytes);
    const [, request] = fetch.mock.calls[0]!;
    expect(request?.method).toBeUndefined();
    expect(new Headers(request?.headers).get("authorization")).toContain(
      "AWS4-HMAC-SHA256 Credential=access/",
    );
  });

  it("writes through the path-style S3 boundary with immutable signed requests", async () => {
    const fetch = vi.fn(
      async (_input: URL | RequestInfo, _init?: RequestInit) =>
        new Response(undefined, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    const storage = new S3CompatibleObjectStorage({
      endpoint: "https://objects.example.test",
      bucket: "enkode",
      region: "us-east-1",
      accessKeyId: "access",
      secretAccessKey: "secret",
    });
    const bytes = new TextEncoder().encode("history");
    await storage.putImmutable({
      key: "organizations/org/workspaces/ws/history/1-1.json.gz",
      bytes,
      contentType: "application/gzip",
      sha256: sha256(bytes),
    });

    const [url, request] = fetch.mock.calls[0]!;
    const headers = new Headers(request?.headers);
    expect(String(url)).toBe(
      "https://objects.example.test/enkode/organizations/org/workspaces/ws/history/1-1.json.gz",
    );
    expect(headers.get("if-none-match")).toBe("*");
    expect(headers.get("x-amz-meta-sha256")).toBe(sha256(bytes));
    expect(headers.get("authorization")).toContain("AWS4-HMAC-SHA256 Credential=access/");
  });

  it("normalizes Material receipts and immutable history writes through one adapter", async () => {
    const fetch = vi.fn(async () => new Response(undefined, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const storage = new S3CompatibleObjectStorage({
      endpoint: "https://objects.example.test",
      bucket: "enkode",
      region: "us-east-1",
      accessKeyId: "access",
      secretAccessKey: "secret",
    });
    const bytes = new TextEncoder().encode("history");

    expect(
      storage.completeUpload({
        storageKey: "organizations/org/materials/guide.pdf",
        filename: " Guide.pdf ",
        contentType: " application/pdf ",
        byteSize: 2048,
        sha256: "A".repeat(64),
      }),
    ).toEqual({
      storageProvider: "s3-compatible",
      storageBucket: "enkode",
      storageKey: "organizations/org/materials/guide.pdf",
      filename: "Guide.pdf",
      contentType: "application/pdf",
      byteSize: 2048,
      sha256: "a".repeat(64),
    });
    await storage.putImmutable({
      key: "organizations/org/workspaces/ws/history/1-1.json.gz",
      bytes,
      contentType: "application/gzip",
      sha256: sha256(bytes),
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("verifies hashes, lengths, ranges, and deterministic organization-scoped keys", () => {
    const bytes = new TextEncoder().encode("chunk");
    const manifest = {
      workspaceId: "workspace-1",
      startSequence: 3,
      endSequence: 4,
      eventCount: 2,
      contentHash: sha256(bytes),
      byteLength: bytes.byteLength,
    };
    expect(() => validateChunk(manifest, bytes)).not.toThrow();
    expect(objectKeys("organization-1", manifest).chunk).toContain(
      `organizations/organization-1/workspaces/workspace-1/history/3-4-${manifest.contentHash}`,
    );
    expect(() => validateChunk({ ...manifest, contentHash: "bad" }, bytes)).toThrow("hash");
    expect(() => validateChunk({ ...manifest, eventCount: 3 }, bytes)).toThrow("event count");
  });

  it("rejects payload sequences and origins that disagree with a valid hash manifest", () => {
    const bytes = gzipSync(
      JSON.stringify({
        version: 1,
        workspaceId: "workspace-1",
        events: [{ sequence: 2, type: "file_change", origin: "guessed" }],
      }),
    );
    const manifest = {
      workspaceId: "workspace-1",
      startSequence: 1,
      endSequence: 1,
      eventCount: 1,
      contentHash: sha256(bytes),
      byteLength: bytes.byteLength,
    };
    expect(() => validateChunkPayload(manifest, bytes)).toThrow("missing or reordered");
  });
});
