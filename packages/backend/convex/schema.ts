import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const role = v.union(v.literal("teacher"), v.literal("student"));
const testKind = v.union(v.literal("input_output"), v.literal("python_harness"));
const testVisibility = v.union(v.literal("public"), v.literal("hidden"));

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

  classrooms: defineTable({
    organizationId: v.id("organizations"),
    courseId: v.id("courses"),
    name: v.string(),
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
