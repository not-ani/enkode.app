import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { appendAuditEvent } from "./audit";
import { createCredentialAdminAuth, createProvisioningAuth, authComponent } from "./auth";
import { requireOrganization, requireRole } from "./authorization";
import { normalizeUsername, studentCredentialEmail, USERNAME_PATTERN } from "./studentCredentials";

const password = v.string();

function validateUsername(username: string) {
  if (username.length < 2 || username.length > 48 || !USERNAME_PATTERN.test(username)) {
    throw new ConvexError(
      "Username must be 2-48 lowercase letters, numbers, dots, dashes, or underscores",
    );
  }
}

function validatePassword(value: string) {
  if (value.length < 8 || value.length > 128) {
    throw new ConvexError("Password must be 8-128 characters");
  }
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const { organization } = await requireRole(ctx, "teacher");
    const users = await ctx.db
      .query("users")
      .withIndex("by_organization_username", (q) => q.eq("organizationId", organization._id))
      .collect();

    return users
      .filter((candidate) => candidate.role === "student")
      .map((student) => ({
        id: student._id,
        displayName: student.displayName,
        username: student.username,
        email: student.email,
      }))
      .sort((left, right) => left.username.localeCompare(right.username));
  },
});

export const prepareProvision = internalQuery({
  args: { username: v.string() },
  handler: async (ctx, args) => {
    const { organization } = await requireRole(ctx, "teacher");
    const username = normalizeUsername(args.username);
    validateUsername(username);

    const existing = await ctx.db
      .query("users")
      .withIndex("by_organization_username", (q) =>
        q.eq("organizationId", organization._id).eq("username", username),
      )
      .unique();
    if (existing) {
      throw new ConvexError("Username is already in use in this organization");
    }

    return {
      organizationId: organization._id,
      organizationSlug: organization.slug,
      username,
    };
  },
});

export const finishProvision = internalMutation({
  args: {
    authUserId: v.string(),
    displayName: v.string(),
    email: v.optional(v.string()),
    organizationId: v.id("organizations"),
    username: v.string(),
  },
  handler: async (ctx, args) => {
    const authenticated = await requireRole(ctx, "teacher");
    requireOrganization(authenticated, args.organizationId);

    const existing = await ctx.db
      .query("users")
      .withIndex("by_organization_username", (q) =>
        q.eq("organizationId", args.organizationId).eq("username", args.username),
      )
      .unique();
    if (existing) {
      throw new ConvexError("Username is already in use in this organization");
    }

    const studentId = await ctx.db.insert("users", {
      organizationId: args.organizationId,
      authUserId: args.authUserId,
      username: args.username,
      displayName: args.displayName,
      email: args.email,
      role: "student",
    });
    await appendAuditEvent(ctx, {
      organizationId: args.organizationId,
      actor: { kind: "user", userId: authenticated.user._id },
      action: "user.provisioned",
      target: { kind: "user", id: studentId },
    });

    return studentId;
  },
});

export const provision = action({
  args: {
    displayName: v.string(),
    email: v.optional(v.string()),
    password,
    username: v.string(),
  },
  handler: async (ctx, args) => {
    const displayName = args.displayName.trim();
    if (!displayName) {
      throw new ConvexError("Student name is required");
    }
    validatePassword(args.password);

    const prepared = await ctx.runQuery(internal.students.prepareProvision, {
      username: args.username,
    });
    const email = args.email?.trim().toLowerCase() || undefined;
    if (email && !/^\S+@\S+\.\S+$/.test(email)) {
      throw new ConvexError("Email is invalid");
    }

    const result = await createProvisioningAuth(ctx).api.signUpEmail({
      body: {
        name: displayName,
        email: studentCredentialEmail(prepared.organizationSlug, prepared.username),
        password: args.password,
      },
    });
    const studentId = await ctx.runMutation(internal.students.finishProvision, {
      authUserId: result.user.id,
      displayName,
      email,
      organizationId: prepared.organizationId,
      username: prepared.username,
    });

    return { id: studentId, displayName, email, username: prepared.username };
  },
});

export const preparePasswordReset = internalQuery({
  args: { studentId: v.id("users") },
  handler: async (ctx, args) => {
    const authenticated = await requireRole(ctx, "teacher");
    const student = await ctx.db.get(args.studentId);
    if (!student) {
      throw new ConvexError("Student not found");
    }
    requireOrganization(authenticated, student.organizationId);
    if (student.role !== "student") {
      throw new ConvexError("Only Student passwords can be reset");
    }
    return { authUserId: student.authUserId };
  },
});

export const recordPasswordReset = internalMutation({
  args: { studentId: v.id("users") },
  handler: async (ctx, args) => {
    const authenticated = await requireRole(ctx, "teacher");
    const student = await ctx.db.get(args.studentId);
    if (!student) {
      throw new ConvexError("Student not found");
    }
    requireOrganization(authenticated, student.organizationId);
    if (student.role !== "student") {
      throw new ConvexError("Only Student passwords can be reset");
    }

    await appendAuditEvent(ctx, {
      organizationId: student.organizationId,
      actor: { kind: "user", userId: authenticated.user._id },
      action: "user.password_reset",
      target: { kind: "user", id: student._id },
    });
  },
});

export const resetPassword = action({
  args: { password, studentId: v.id("users") },
  handler: async (ctx, args) => {
    validatePassword(args.password);
    const student = await ctx.runQuery(internal.students.preparePasswordReset, {
      studentId: args.studentId,
    });
    const { auth, headers } = await authComponent.getAuth(createCredentialAdminAuth, ctx);
    await auth.api.setUserPassword({
      body: { newPassword: args.password, userId: student.authUserId },
      headers,
    });
    await ctx.runMutation(internal.students.recordPasswordReset, {
      studentId: args.studentId,
    });

    return { success: true };
  },
});
