import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const role = v.union(v.literal("teacher"), v.literal("student"));
const testKind = v.union(v.literal("input_output"), v.literal("python_harness"));
const testVisibility = v.union(v.literal("public"), v.literal("hidden"));
const releasePublicationState = v.union(
  v.literal("draft"),
  v.literal("scheduled"),
  v.literal("published"),
);
const materialKind = v.union(v.literal("rich_text"), v.literal("file"), v.literal("external_link"));
const integritySignalType = v.union(
  v.literal("large_paste"),
  v.literal("unattributed_bulk_change"),
  v.literal("work_history_gap"),
  v.literal("similarity"),
);
const integritySignalState = v.union(
  v.literal("open"),
  v.literal("reviewed"),
  v.literal("dismissed"),
);
const inlineFeedback = v.object({
  path: v.string(),
  snapshotFileContentHash: v.string(),
  startLine: v.number(),
  startColumn: v.number(),
  endLine: v.number(),
  endColumn: v.number(),
  body: v.string(),
});

export default defineSchema({
  organizations: defineTable({
    name: v.string(),
    slug: v.string(),
  }).index("by_slug", ["slug"]),

  users: defineTable({
    organizationId: v.id("organizations"),
    authUserId: v.string(),
    username: v.string(),
    displayName: v.string(),
    email: v.optional(v.string()),
    role,
  })
    .index("by_auth_user", ["authUserId"])
    .index("by_organization_username", ["organizationId", "username"])
    .index("by_organization_email", ["organizationId", "email"]),

  courses: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    archivedAt: v.optional(v.number()),
    archivedBy: v.optional(v.id("users")),
  }).index("by_organization", ["organizationId"]),

  courseCollaborators: defineTable({
    organizationId: v.id("organizations"),
    courseId: v.id("courses"),
    teacherId: v.id("users"),
  })
    .index("by_course", ["courseId"])
    .index("by_course_teacher", ["courseId", "teacherId"])
    .index("by_teacher", ["teacherId"]),

  assignments: defineTable({
    organizationId: v.id("organizations"),
    courseId: v.id("courses"),
    title: v.string(),
    latestVersion: v.number(),
    archivedAt: v.optional(v.number()),
    archivedBy: v.optional(v.id("users")),
  })
    .index("by_course", ["courseId"])
    .index("by_organization", ["organizationId"]),

  assignmentVersions: defineTable({
    organizationId: v.id("organizations"),
    assignmentId: v.id("assignments"),
    version: v.number(),
    instructions: v.string(),
    language: v.literal("python"),
    runtimeVersion: v.string(),
    entrypoint: v.string(),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_assignment", ["assignmentId", "version"])
    .index("by_runtime", ["language", "runtimeVersion"]),

  assignmentStarterFiles: defineTable({
    organizationId: v.id("organizations"),
    assignmentVersionId: v.id("assignmentVersions"),
    path: v.string(),
    content: v.string(),
    order: v.number(),
  }).index("by_version", ["assignmentVersionId", "order"]),

  evaluationTests: defineTable({
    organizationId: v.id("organizations"),
    assignmentVersionId: v.id("assignmentVersions"),
    name: v.string(),
    kind: testKind,
    visibility: testVisibility,
    weight: v.number(),
    stdin: v.optional(v.string()),
    expectedOutput: v.optional(v.string()),
    harness: v.optional(v.string()),
    passGuidance: v.optional(v.string()),
    failGuidance: v.optional(v.string()),
    order: v.number(),
  }).index("by_version", ["assignmentVersionId", "order"]),

  materials: defineTable({
    organizationId: v.id("organizations"),
    courseId: v.id("courses"),
    title: v.string(),
    latestVersion: v.number(),
    archivedAt: v.optional(v.number()),
    archivedBy: v.optional(v.id("users")),
  })
    .index("by_course", ["courseId"])
    .index("by_organization", ["organizationId"]),

  materialAttachments: defineTable({
    organizationId: v.id("organizations"),
    storageProvider: v.string(),
    storageBucket: v.string(),
    storageKey: v.string(),
    filename: v.string(),
    contentType: v.string(),
    byteSize: v.number(),
    sha256: v.string(),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_organization_storage_key", ["organizationId", "storageKey"])
    .index("by_storage_location", ["storageProvider", "storageBucket", "storageKey"]),

  materialVersions: defineTable({
    organizationId: v.id("organizations"),
    materialId: v.id("materials"),
    version: v.number(),
    kind: materialKind,
    richText: v.optional(v.string()),
    externalUrl: v.optional(v.string()),
    attachmentId: v.optional(v.id("materialAttachments")),
    createdBy: v.id("users"),
    createdAt: v.number(),
  }).index("by_material", ["materialId", "version"]),

  classrooms: defineTable({
    organizationId: v.id("organizations"),
    courseId: v.id("courses"),
    name: v.string(),
    archivedAt: v.optional(v.number()),
    archivedBy: v.optional(v.id("users")),
  })
    .index("by_organization", ["organizationId"])
    .index("by_course", ["courseId"]),

  classroomTeachers: defineTable({
    organizationId: v.id("organizations"),
    classroomId: v.id("classrooms"),
    teacherId: v.id("users"),
  })
    .index("by_classroom", ["classroomId"])
    .index("by_classroom_teacher", ["classroomId", "teacherId"])
    .index("by_teacher", ["teacherId"]),

  enrollments: defineTable({
    organizationId: v.id("organizations"),
    classroomId: v.id("classrooms"),
    studentId: v.id("users"),
    status: v.union(v.literal("active"), v.literal("ended")),
    endedAt: v.optional(v.number()),
  })
    .index("by_classroom", ["classroomId"])
    .index("by_classroom_student", ["classroomId", "studentId"])
    .index("by_student_status", ["studentId", "status"]),

  assignmentReleases: defineTable({
    organizationId: v.id("organizations"),
    classroomId: v.id("classrooms"),
    assignmentId: v.id("assignments"),
    assignmentVersionId: v.id("assignmentVersions"),
    points: v.number(),
    order: v.number(),
    publicationState: v.optional(releasePublicationState),
    scheduledFor: v.optional(v.number()),
    scheduledBy: v.optional(v.id("users")),
    publishedAt: v.optional(v.number()),
    submissionLimit: v.optional(v.number()),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_classroom", ["classroomId", "order"])
    .index("by_classroom_assignment", ["classroomId", "assignmentId"]),

  assignmentReleaseAdoptions: defineTable({
    organizationId: v.id("organizations"),
    assignmentReleaseId: v.id("assignmentReleases"),
    fromAssignmentVersionId: v.id("assignmentVersions"),
    toAssignmentVersionId: v.id("assignmentVersions"),
    adoptedBy: v.id("users"),
    adoptedAt: v.number(),
  }).index("by_release", ["assignmentReleaseId", "adoptedAt"]),

  materialReleases: defineTable({
    organizationId: v.id("organizations"),
    classroomId: v.id("classrooms"),
    materialId: v.id("materials"),
    materialVersionId: v.id("materialVersions"),
    order: v.number(),
    publicationState: releasePublicationState,
    scheduledFor: v.optional(v.number()),
    scheduledBy: v.optional(v.id("users")),
    publishedAt: v.optional(v.number()),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_classroom", ["classroomId", "order"])
    .index("by_classroom_material", ["classroomId", "materialId"]),

  workspaces: defineTable({
    organizationId: v.id("organizations"),
    assignmentReleaseId: v.id("assignmentReleases"),
    assignmentVersionId: v.id("assignmentVersions"),
    studentId: v.id("users"),
    files: v.array(v.object({ path: v.string(), content: v.string() })),
    createdAt: v.number(),
    updatedAt: v.number(),
    historyAckSequence: v.optional(v.number()),
  })
    .index("by_release_student", ["assignmentReleaseId", "studentId"])
    .index("by_assignment_release", ["assignmentReleaseId"])
    .index("by_student", ["studentId"]),

  workspaceVersionMerges: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    assignmentReleaseId: v.id("assignmentReleases"),
    adoptionId: v.id("assignmentReleaseAdoptions"),
    fromAssignmentVersionId: v.id("assignmentVersions"),
    toAssignmentVersionId: v.id("assignmentVersions"),
    status: v.union(v.literal("pending"), v.literal("completed"), v.literal("superseded")),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
    decisions: v.optional(
      v.array(
        v.object({
          path: v.string(),
          choice: v.union(v.literal("keep_current"), v.literal("accept_new")),
        }),
      ),
    ),
    historySequence: v.optional(v.number()),
  })
    .index("by_workspace_status", ["workspaceId", "status"])
    .index("by_adoption", ["adoptionId"]),

  workHistoryChunks: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    studentId: v.id("users"),
    startSequence: v.number(),
    endSequence: v.number(),
    eventCount: v.number(),
    contentHash: v.string(),
    objectKey: v.string(),
    byteLength: v.number(),
    encoding: v.literal("gzip-json-v1"),
    snapshotHash: v.optional(v.string()),
    snapshotObjectKey: v.optional(v.string()),
    snapshotByteLength: v.optional(v.number()),
    committedAt: v.number(),
  })
    .index("by_workspace_sequence", ["workspaceId", "startSequence"])
    .index("by_workspace_hash", ["workspaceId", "contentHash"]),

  workspaceAssignmentVersionMergeEvents: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    sequence: v.number(),
    fromAssignmentVersionId: v.string(),
    toAssignmentVersionId: v.string(),
    acceptedPaths: v.array(v.string()),
    committedAt: v.number(),
  }).index("by_workspace_sequence", ["workspaceId", "sequence"]),

  workspaceViewerPresences: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    teacherId: v.id("users"),
    sessionId: v.string(),
    expiresAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_session", ["workspaceId", "sessionId"])
    .index("by_teacher", ["teacherId"]),

  runs: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    assignmentReleaseId: v.id("assignmentReleases"),
    assignmentVersionId: v.id("assignmentVersions"),
    studentId: v.id("users"),
    runtimeVersion: v.string(),
    entrypoint: v.string(),
    files: v.array(v.object({ path: v.string(), content: v.string() })),
    execution: v.object({
      status: v.union(v.literal("completed"), v.literal("failed"), v.literal("timed_out")),
      stdout: v.string(),
      stderr: v.string(),
      exitCode: v.union(v.number(), v.null()),
      signal: v.union(v.string(), v.null()),
    }),
    publicTestResults: v.array(
      v.object({
        evaluationTestId: v.id("evaluationTests"),
        name: v.string(),
        passed: v.boolean(),
        stdout: v.string(),
        stderr: v.string(),
        exitCode: v.union(v.number(), v.null()),
      }),
    ),
    completedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId", "completedAt"])
    .index("by_student", ["studentId", "completedAt"]),

  submissionSnapshots: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    assignmentVersionId: v.id("assignmentVersions"),
    historySequence: v.number(),
    objectKey: v.string(),
    contentHash: v.string(),
    byteLength: v.number(),
    files: v.array(v.object({ path: v.string(), contentHash: v.string(), byteLength: v.number() })),
    createdAt: v.number(),
  }).index("by_workspace", ["workspaceId", "createdAt"]),

  submissions: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    assignmentReleaseId: v.id("assignmentReleases"),
    assignmentVersionId: v.id("assignmentVersions"),
    studentId: v.id("users"),
    snapshotId: v.id("submissionSnapshots"),
    idempotencyKey: v.string(),
    attemptNumber: v.number(),
    runtimeVersion: v.string(),
    entrypoint: v.string(),
    execution: v.object({
      status: v.union(v.literal("completed"), v.literal("failed"), v.literal("timed_out")),
      stdout: v.string(),
      stderr: v.string(),
      exitCode: v.union(v.number(), v.null()),
      signal: v.union(v.string(), v.null()),
    }),
    testResults: v.array(
      v.object({
        evaluationTestId: v.id("evaluationTests"),
        name: v.string(),
        visibility: testVisibility,
        weight: v.number(),
        passed: v.boolean(),
        guidance: v.optional(v.string()),
        stdout: v.string(),
        stderr: v.string(),
        exitCode: v.union(v.number(), v.null()),
      }),
    ),
    proposedPoints: v.number(),
    submittedAt: v.number(),
  })
    .index("by_workspace_attempt", ["workspaceId", "attemptNumber"])
    .index("by_workspace_idempotency", ["workspaceId", "idempotencyKey"])
    .index("by_release_student_attempt", ["assignmentReleaseId", "studentId", "attemptNumber"])
    .index("by_organization_version", ["organizationId", "assignmentVersionId", "submittedAt"]),
  integritySignals: defineTable({
    organizationId: v.id("organizations"),
    workspaceId: v.id("workspaces"),
    studentId: v.id("users"),
    type: integritySignalType,
    state: integritySignalState,
    evidenceKey: v.string(),
    eventSequence: v.optional(v.number()),
    path: v.optional(v.string()),
    insertedCharacters: v.optional(v.number()),
    deletedCharacters: v.optional(v.number()),
    resultingFileCharacters: v.optional(v.number()),
    contribution: v.optional(v.number()),
    sequenceStart: v.optional(v.number()),
    sequenceEnd: v.optional(v.number()),
    gapReason: v.optional(v.string()),
    relatedWorkspaceId: v.optional(v.id("workspaces")),
    relatedStudentId: v.optional(v.id("users")),
    submissionId: v.optional(v.id("submissions")),
    relatedSubmissionId: v.optional(v.id("submissions")),
    submissionHistorySequence: v.optional(v.number()),
    relatedSubmissionHistorySequence: v.optional(v.number()),
    matchedSpans: v.optional(
      v.array(
        v.object({
          path: v.string(),
          start: v.number(),
          end: v.number(),
          relatedPath: v.string(),
          relatedStart: v.number(),
          relatedEnd: v.number(),
          text: v.string(),
        }),
      ),
    ),
    createdAt: v.number(),
    reviewedBy: v.optional(v.id("users")),
    reviewedAt: v.optional(v.number()),
    teacherNote: v.optional(v.string()),
  })
    .index("by_workspace", ["workspaceId", "createdAt"])
    .index("by_related_workspace", ["relatedWorkspaceId", "createdAt"])
    .index("by_evidence_key", ["evidenceKey"]),

  grades: defineTable({
    organizationId: v.id("organizations"),
    assignmentReleaseId: v.id("assignmentReleases"),
    studentId: v.id("users"),
    submissionId: v.id("submissions"),
    proposedPoints: v.number(),
    points: v.number(),
    overallFeedback: v.optional(v.string()),
    inlineFeedback: v.array(inlineFeedback),
    latestReturnId: v.optional(v.id("gradeReturns")),
    updatedBy: v.id("users"),
    updatedAt: v.number(),
  })
    .index("by_release_student", ["assignmentReleaseId", "studentId"])
    .index("by_submission", ["submissionId"]),

  gradeReturns: defineTable({
    organizationId: v.id("organizations"),
    gradeId: v.id("grades"),
    assignmentReleaseId: v.id("assignmentReleases"),
    studentId: v.id("users"),
    submissionId: v.id("submissions"),
    proposedPoints: v.number(),
    points: v.number(),
    overallFeedback: v.optional(v.string()),
    inlineFeedback: v.array(inlineFeedback),
    revision: v.number(),
    returnedBy: v.id("users"),
    returnedAt: v.number(),
  })
    .index("by_grade_revision", ["gradeId", "revision"])
    .index("by_release_student_revision", ["assignmentReleaseId", "studentId", "revision"]),

  auditEvents: defineTable({
    organizationId: v.id("organizations"),
    actorKind: v.union(v.literal("developer"), v.literal("user")),
    actorUserId: v.optional(v.id("users")),
    action: v.string(),
    targetKind: v.string(),
    targetId: v.string(),
    occurredAt: v.number(),
  })
    .index("by_organization", ["organizationId", "occurredAt"])
    .index("by_target", ["targetKind", "targetId", "occurredAt"]),
});
