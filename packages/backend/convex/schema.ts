import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const role = v.union(v.literal("teacher"), v.literal("student"));

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
