import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import { admin } from "better-auth/plugins";
import { adminAc } from "better-auth/plugins/admin/access";

import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";

export const authComponent = createClient<DataModel>(components.betterAuth);

function authOptions(ctx: GenericCtx<DataModel>, disableSignUp: boolean) {
  const siteUrl = process.env.SITE_URL;
  if (!siteUrl) {
    throw new Error("SITE_URL is not configured");
  }

  return {
    baseURL: siteUrl,
    trustedOrigins: [siteUrl],
    database: authComponent.adapter(ctx),
    emailAndPassword: {
      enabled: true,
      disableSignUp,
      requireEmailVerification: false,
    },
    plugins: [
      convex({
        authConfig,
        jwksRotateOnTokenGenerationError: true,
      }),
    ],
  };
}

export function createAuth(ctx: GenericCtx<DataModel>) {
  return betterAuth(authOptions(ctx, true));
}

export function createProvisioningAuth(ctx: GenericCtx<DataModel>) {
  return betterAuth(authOptions(ctx, false));
}

export function createCredentialAdminAuth(ctx: GenericCtx<DataModel>) {
  const options = authOptions(ctx, true);
  return betterAuth({
    ...options,
    plugins: [
      ...options.plugins,
      admin({
        adminRoles: ["user"],
        roles: { user: adminAc },
      }),
    ],
  });
}
