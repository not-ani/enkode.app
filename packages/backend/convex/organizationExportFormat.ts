import { z } from "zod";

export const ORGANIZATION_EXPORT_FORMAT = "enkode.organization-export" as const;
export const ORGANIZATION_EXPORT_VERSION = 1 as const;

export const organizationExportRecordNames = [
  "users",
  "courses",
  "courseCollaborators",
  "assignments",
  "assignmentVersions",
  "assignmentStarterFiles",
  "evaluationTests",
  "materials",
  "materialAttachments",
  "materialVersions",
  "classrooms",
  "classroomTeachers",
  "enrollments",
  "assignmentReleases",
  "assignmentReleaseAdoptions",
  "deadlineExceptions",
  "materialReleases",
  "workspaces",
  "workspaceVersionMerges",
  "workHistoryChunks",
  "workspaceAssignmentVersionMergeEvents",
  "runs",
  "submissionSnapshots",
  "submissions",
  "integritySignals",
  "grades",
  "gradeReturns",
  "notifications",
  "auditEvents",
] as const;

const exportedRecord = z.object({ id: z.string(), createdAtInDatabase: z.number() }).loose();
const recordsShape = Object.fromEntries(
  organizationExportRecordNames.map((name) => [name, z.array(exportedRecord)]),
) as Record<(typeof organizationExportRecordNames)[number], z.ZodArray<typeof exportedRecord>>;

export const organizationExportV1Schema = z.object({
  format: z.literal(ORGANIZATION_EXPORT_FORMAT),
  version: z.literal(ORGANIZATION_EXPORT_VERSION),
  exportedAt: z.iso.datetime(),
  organization: exportedRecord.extend({ name: z.string(), slug: z.string() }),
  records: z.object(recordsShape),
  objects: z.array(
    z.object({
      path: z.string().startsWith("objects/sha256/"),
      contentType: z.string(),
      byteLength: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      encoding: z.literal("base64"),
      data: z.string(),
      sourceReferences: z.array(
        z.object({ kind: z.string(), recordId: z.string(), field: z.string() }),
      ),
    }),
  ),
});

export type OrganizationExportV1 = z.infer<typeof organizationExportV1Schema>;
