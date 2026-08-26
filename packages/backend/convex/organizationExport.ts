"use node";

import { z } from "zod";

import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";
import type { ObjectStorage } from "./objectStorage";
import { objectStorageFromEnvironment } from "./objectStorage";
import {
  ORGANIZATION_EXPORT_FORMAT,
  ORGANIZATION_EXPORT_VERSION,
  organizationExportRecordNames,
  organizationExportV1Schema,
} from "./organizationExportFormat";

type RecordName = (typeof organizationExportRecordNames)[number];
type Snapshot = {
  organization: Doc<"organizations">;
  records: { [Name in RecordName]: Doc<Name>[] };
};

type ObjectReference = {
  key: string;
  sha256: string;
  byteLength: number;
  contentType: string;
  source: { kind: string; recordId: string; field: string };
};

function exportedRecord(record: Record<string, unknown>) {
  const { _id, _creationTime, ...fields } = record;
  return { id: String(_id), createdAtInDatabase: _creationTime, ...fields };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
}

function objectReferences(snapshot: Snapshot) {
  const references: ObjectReference[] = [];
  for (const attachment of snapshot.records.materialAttachments) {
    references.push({
      key: attachment.storageKey,
      sha256: attachment.sha256,
      byteLength: attachment.byteSize,
      contentType: attachment.contentType,
      source: { kind: "materialAttachment", recordId: attachment._id, field: "content" },
    });
  }
  for (const chunk of snapshot.records.workHistoryChunks) {
    references.push({
      key: chunk.objectKey,
      sha256: chunk.contentHash,
      byteLength: chunk.byteLength,
      contentType: "application/gzip",
      source: { kind: "workHistoryChunk", recordId: chunk._id, field: "chunk" },
    });
    if (chunk.snapshotObjectKey && chunk.snapshotHash && chunk.snapshotByteLength !== undefined) {
      references.push({
        key: chunk.snapshotObjectKey,
        sha256: chunk.snapshotHash,
        byteLength: chunk.snapshotByteLength,
        contentType: "application/gzip",
        source: { kind: "workHistoryChunk", recordId: chunk._id, field: "snapshot" },
      });
    }
  }
  for (const snapshotRecord of snapshot.records.submissionSnapshots) {
    references.push({
      key: snapshotRecord.objectKey,
      sha256: snapshotRecord.contentHash,
      byteLength: snapshotRecord.byteLength,
      contentType: "application/json",
      source: { kind: "submissionSnapshot", recordId: snapshotRecord._id, field: "snapshot" },
    });
  }
  return references;
}

function assertIsolated(snapshot: Snapshot) {
  const organizationId = snapshot.organization._id;
  for (const name of organizationExportRecordNames) {
    for (const record of snapshot.records[name]) {
      if (record.organizationId !== organizationId) {
        throw new Error(`Organization Export isolation failed for ${name}/${record._id}`);
      }
    }
  }
}

function toBase64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64");
}

export async function buildOrganizationExport(
  readSnapshot: () => Promise<Snapshot>,
  storage: ObjectStorage | undefined,
  exportedAt: string,
) {
  const snapshot = await readSnapshot();
  assertIsolated(snapshot);
  const references = objectReferences(snapshot);
  if (references.length > 0 && !storage) throw new Error("Organization Export storage unavailable");

  const grouped = new Map<
    string,
    { reference: ObjectReference; sources: ObjectReference["source"][] }
  >();
  for (const reference of references) {
    const identity = `${reference.sha256}:${reference.byteLength}`;
    const current = grouped.get(identity);
    if (current) current.sources.push(reference.source);
    else grouped.set(identity, { reference, sources: [reference.source] });
  }
  const objects = await Promise.all(
    [...grouped.values()]
      .sort((left, right) => left.reference.sha256.localeCompare(right.reference.sha256))
      .map(async ({ reference, sources }) => {
        const bytes = await storage!.getImmutable(reference);
        return {
          path: `objects/sha256/${reference.sha256}`,
          contentType: reference.contentType,
          byteLength: reference.byteLength,
          sha256: reference.sha256,
          encoding: "base64" as const,
          data: toBase64(bytes),
          sourceReferences: sources.sort((left, right) =>
            `${left.kind}:${left.recordId}:${left.field}`.localeCompare(
              `${right.kind}:${right.recordId}:${right.field}`,
            ),
          ),
        };
      }),
  );
  const records = Object.fromEntries(
    organizationExportRecordNames.map((name) => [
      name,
      snapshot.records[name]
        .map((record: Record<string, unknown>) => exportedRecord(record))
        .sort((left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id)),
    ]),
  );
  const bundle = {
    format: ORGANIZATION_EXPORT_FORMAT,
    version: ORGANIZATION_EXPORT_VERSION,
    exportedAt,
    organization: exportedRecord(snapshot.organization),
    records,
    objects,
  };
  return JSON.stringify(canonical(organizationExportV1Schema.parse(bundle)));
}

const exportOrganizationBody = z.object({
  organizationSlug: z.string().trim().min(2).max(48),
});

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export const exportOrganizationHttp = httpAction(async (ctx, request) => {
  const secret = process.env.DEVELOPER_PROVISIONING_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return json({ error: "Not found" }, 404);
  }
  const parsed = exportOrganizationBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid Organization Export request" }, 400);
  const organizationSlug = parsed.data.organizationSlug.toLowerCase();
  try {
    const snapshot = await ctx.runQuery(internal.organizationExportRead.readOrganizationSnapshot, {
      organizationSlug,
    });
    const hasObjects = objectReferences(snapshot).length > 0;
    const bundle = await buildOrganizationExport(
      () => Promise.resolve(snapshot),
      hasObjects ? objectStorageFromEnvironment() : undefined,
      new Date().toISOString(),
    );
    return new Response(bundle, {
      status: 200,
      headers: {
        "content-type": "application/vnd.enkode.organization-export+json;version=1",
        "content-disposition": `attachment; filename="${organizationSlug}-enkode-export-v1.json"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Organization Export failed";
    return json({ error: message }, message.includes("not found") ? 404 : 409);
  }
});
