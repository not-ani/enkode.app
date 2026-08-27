import { ConvexError, v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";
import { appendAuditEvent } from "./audit";

export const ensureAvailable = internalQuery({
  args: {
    organizationSlug: v.string(),
  },
  handler: async (ctx, args) => {
    const organization = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (query) => query.eq("slug", args.organizationSlug))
      .unique();
    if (organization) {
      throw new ConvexError("Organization slug is already in use");
    }
  },
});

export const createOrganizationAndTeacher = internalMutation({
  args: {
    authUserId: v.string(),
    organizationName: v.string(),
    organizationSlug: v.string(),
    teacherName: v.string(),
    teacherUsername: v.string(),
    teacherEmail: v.string(),
  },
  handler: async (ctx, args) => {
    const existingOrganization = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (query) => query.eq("slug", args.organizationSlug))
      .unique();
    if (existingOrganization) {
      throw new ConvexError("Organization slug is already in use");
    }

    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_auth_user", (query) => query.eq("authUserId", args.authUserId))
      .unique();
    if (existingUser) {
      throw new ConvexError("Authentication identity is already provisioned");
    }

    const organizationId = await ctx.db.insert("organizations", {
      name: args.organizationName,
      slug: args.organizationSlug,
    });
    const teacherId = await ctx.db.insert("users", {
      organizationId,
      authUserId: args.authUserId,
      username: args.teacherUsername,
      displayName: args.teacherName,
      email: args.teacherEmail,
      role: "teacher",
    });

    await appendAuditEvent(ctx, {
      organizationId,
      actor: { kind: "developer" },
      action: "organization.provisioned",
      target: { kind: "organization", id: organizationId },
    });
    await appendAuditEvent(ctx, {
      organizationId,
      actor: { kind: "developer" },
      action: "user.provisioned",
      target: { kind: "user", id: teacherId },
    });
    await appendAuditEvent(ctx, {
      organizationId,
      actor: { kind: "developer" },
      action: "user.teacher_role_assigned",
      target: { kind: "user", id: teacherId },
    });

    return { organizationId, teacherId };
  },
});
