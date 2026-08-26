import { ConvexError } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

type DatabaseCtx = QueryCtx | MutationCtx;
type Role = Doc<"users">["role"];

export async function requireAuthenticatedUser(ctx: DatabaseCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new ConvexError("Unauthenticated");
  }

  const user = await ctx.db
    .query("users")
    .withIndex("by_auth_user", (query) => query.eq("authUserId", identity.subject))
    .unique();
  if (!user) {
    throw new ConvexError("User is not provisioned");
  }

  const organization = await ctx.db.get(user.organizationId);
  if (!organization) {
    throw new ConvexError("User organization is unavailable");
  }

  return { organization, user };
}

export async function requireRole(ctx: DatabaseCtx, role: Role) {
  const authenticated = await requireAuthenticatedUser(ctx);
  if (authenticated.user.role !== role) {
    throw new ConvexError("Forbidden");
  }
  return authenticated;
}

export function requireOrganization(
  authenticated: Awaited<ReturnType<typeof requireAuthenticatedUser>>,
  organizationId: Id<"organizations">,
) {
  if (authenticated.organization._id !== organizationId) {
    throw new ConvexError("Forbidden");
  }
}
