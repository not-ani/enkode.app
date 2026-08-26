import { httpRouter } from "convex/server";
import { z } from "zod";

import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth, createProvisioningAuth } from "./auth";
import { exportOrganizationHttp } from "./organizationExport";

const http = httpRouter();

authComponent.registerRoutes(http, createAuth);

const provisionOrganizationBody = z.object({
  organization: z.object({
    name: z.string().trim().min(1),
    slug: z
      .string()
      .trim()
      .min(2)
      .max(48)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  }),
  teacher: z.object({
    name: z.string().trim().min(1),
    username: z
      .string()
      .trim()
      .min(2)
      .max(48)
      .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
    email: z.email(),
    password: z.string().min(8).max(128),
  }),
});

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const provisionOrganization = httpAction(async (ctx, request) => {
  const secret = process.env.DEVELOPER_PROVISIONING_SECRET;
  const authorization = request.headers.get("authorization");
  if (!secret || authorization !== `Bearer ${secret}`) {
    return json({ error: "Not found" }, 404);
  }

  const parsed = provisionOrganizationBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return json({ error: "Invalid provisioning request" }, 400);
  }

  const organizationSlug = parsed.data.organization.slug.toLowerCase();
  const teacherUsername = parsed.data.teacher.username.toLowerCase();
  const teacherEmail = parsed.data.teacher.email.toLowerCase();

  try {
    await ctx.runQuery(internal.provisioning.ensureAvailable, {
      organizationSlug,
    });

    const result = await createProvisioningAuth(ctx).api.signUpEmail({
      body: {
        name: parsed.data.teacher.name,
        email: teacherEmail,
        password: parsed.data.teacher.password,
      },
    });

    const provisioned = await ctx.runMutation(internal.provisioning.createOrganizationAndTeacher, {
      authUserId: result.user.id,
      organizationName: parsed.data.organization.name,
      organizationSlug,
      teacherName: parsed.data.teacher.name,
      teacherUsername,
      teacherEmail,
    });

    return json(
      {
        organizationId: provisioned.organizationId,
        teacherId: provisioned.teacherId,
        authUserId: result.user.id,
      },
      201,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Provisioning failed";
    return json({ error: message }, 409);
  }
});

http.route({
  path: "/api/developer/provision-organization",
  method: "POST",
  handler: provisionOrganization,
});

http.route({
  path: "/api/developer/export-organization",
  method: "POST",
  handler: exportOrganizationHttp,
});

export default http;
