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

/**
 * Material authoring consumes only a provider-neutral upload receipt. The upload
 * adapter owns credentials and bytes; this boundary supplies the configured,
 * exportable location metadata after that adapter has completed the upload.
 */
export function configuredObjectStorage(): ObjectStorageBoundary {
  const storageProvider = requiredConfiguration("ENKODE_OBJECT_STORAGE_PROVIDER");
  const storageBucket = requiredConfiguration("ENKODE_OBJECT_STORAGE_BUCKET");
  return {
    completeUpload(receipt) {
      return { storageProvider, storageBucket, ...validateStoredObjectReceipt(receipt) };
    },
  };
}
