import { createHash, createHmac } from "node:crypto";
import { ConvexError, v } from "convex/values";

export const storedObjectReceipt = v.object({
  storageKey: v.string(),
  filename: v.string(),
  contentType: v.string(),
  byteSize: v.number(),
  sha256: v.string(),
});

export type StoredObjectReceipt = {
  storageKey: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
};

export type StoredObjectMetadata = StoredObjectReceipt & {
  storageProvider: string;
  storageBucket: string;
};

export interface ObjectStorageBoundary {
  completeUpload(receipt: StoredObjectReceipt): StoredObjectMetadata;
}

export type ImmutableObject = {
  key: string;
  bytes: Uint8Array;
  contentType: string;
  sha256: string;
};

/** Provider-neutral storage contract shared by uploaded assets and immutable domain objects. */
export interface ObjectStorage extends ObjectStorageBoundary {
  putImmutable(object: ImmutableObject): Promise<void>;
}

function requiredConfiguration(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new ConvexError(`Object storage is not configured (${name})`);
  return value;
}

function cleanRequired(value: string, label: string) {
  const cleaned = value.trim();
  if (!cleaned) throw new ConvexError(`${label} is required`);
  return cleaned;
}

export function validateStoredObjectReceipt(receipt: StoredObjectReceipt) {
  const storageKey = cleanRequired(receipt.storageKey, "Storage key");
  if (storageKey.startsWith("/") || storageKey.includes("..")) {
    throw new ConvexError("Storage key must be a relative object key");
  }
  const filename = cleanRequired(receipt.filename, "Attachment filename");
  const contentType = cleanRequired(receipt.contentType, "Attachment content type");
  if (!Number.isSafeInteger(receipt.byteSize) || receipt.byteSize < 0) {
    throw new ConvexError("Attachment byte size must be a non-negative integer");
  }
  const sha256 = receipt.sha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new ConvexError("Attachment SHA-256 must be 64 hexadecimal characters");
  }
  return { storageKey, filename, contentType, byteSize: receipt.byteSize, sha256 };
}

class ProviderNeutralObjectStorage implements ObjectStorageBoundary {
  constructor(
    readonly storageProvider: string,
    readonly storageBucket: string,
  ) {}

  completeUpload(receipt: StoredObjectReceipt) {
    return {
      storageProvider: this.storageProvider,
      storageBucket: this.storageBucket,
      ...validateStoredObjectReceipt(receipt),
    };
  }
}

/**
 * Material authoring consumes only a provider-neutral upload receipt. The upload
 * adapter owns credentials and bytes; this boundary supplies the configured,
 * exportable location metadata after that adapter has completed the upload.
 */
export function configuredObjectStorage(): ObjectStorageBoundary {
  const storageProvider = requiredConfiguration("ENKODE_OBJECT_STORAGE_PROVIDER");
  const storageBucket = requiredConfiguration("ENKODE_OBJECT_STORAGE_BUCKET");
  return new ProviderNeutralObjectStorage(storageProvider, storageBucket);
}

function hmac(key: Uint8Array | string, value: string) {
  return createHmac("sha256", key).update(value).digest();
}

function encodePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** Minimal path-style S3 adapter. Provider details stop at this boundary. */
export class S3CompatibleObjectStorage
  extends ProviderNeutralObjectStorage
  implements ObjectStorage
{
  constructor(
    private readonly config: {
      endpoint: string;
      bucket: string;
      region: string;
      accessKeyId: string;
      secretAccessKey: string;
      provider?: string;
    },
  ) {
    super(config.provider ?? "s3-compatible", config.bucket);
  }

  async putImmutable(object: ImmutableObject) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const endpoint = new URL(this.config.endpoint);
    const pathname = `/${encodeURIComponent(this.config.bucket)}/${encodePath(object.key)}`;
    const headers = {
      "content-type": object.contentType,
      "if-none-match": "*",
      "x-amz-content-sha256": object.sha256,
      "x-amz-date": amzDate,
      "x-amz-meta-sha256": object.sha256,
    };
    const signedHeaderNames = Object.keys(headers).concat("host").sort();
    const canonicalHeaders = signedHeaderNames
      .map(
        (name) =>
          `${name}:${name === "host" ? endpoint.host : headers[name as keyof typeof headers]}`,
      )
      .join("\n");
    const canonicalRequest = [
      "PUT",
      pathname,
      "",
      canonicalHeaders,
      signedHeaderNames.join(";"),
      object.sha256,
    ].join("\n");
    const scope = `${date}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    const dateKey = hmac(`AWS4${this.config.secretAccessKey}`, date);
    const regionKey = hmac(dateKey, this.config.region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    const response = await fetch(new URL(pathname, endpoint), {
      method: "PUT",
      headers: {
        ...headers,
        authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`,
      },
      body: Buffer.from(object.bytes),
    });
    if (response.status === 412) return;
    if (!response.ok) throw new Error(`Object storage PUT failed (${response.status})`);
  }
}

export class FakeObjectStorage extends ProviderNeutralObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, ImmutableObject>();

  constructor() {
    super("fake", "memory");
  }

  async putImmutable(object: ImmutableObject) {
    if (createHash("sha256").update(object.bytes).digest("hex") !== object.sha256) {
      throw new Error("Immutable object hash does not match its bytes");
    }
    const existing = this.objects.get(object.key);
    if (existing && existing.sha256 !== object.sha256) {
      throw new Error("Immutable object key already contains different bytes");
    }
    if (!existing) this.objects.set(object.key, { ...object, bytes: object.bytes.slice() });
  }
}

export function objectStorageFromEnvironment(): ObjectStorage {
  const endpoint = process.env.ENKODE_OBJECT_STORAGE_ENDPOINT;
  const bucket = process.env.ENKODE_OBJECT_STORAGE_BUCKET;
  const region = process.env.ENKODE_OBJECT_STORAGE_REGION;
  const accessKeyId = process.env.ENKODE_OBJECT_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.ENKODE_OBJECT_STORAGE_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !region || !accessKeyId || !secretAccessKey) {
    throw new Error("S3-compatible Work History object storage is not configured");
  }
  return new S3CompatibleObjectStorage({ endpoint, bucket, region, accessKeyId, secretAccessKey });
}
