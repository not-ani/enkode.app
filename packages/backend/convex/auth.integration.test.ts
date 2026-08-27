import betterAuthTest from "@convex-dev/better-auth/test";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const provisioningRequest = {
  organization: { name: "Example Academy", slug: "example-academy" },
  teacher: {
    name: "Ada Lovelace",
    username: "ada",
    email: "ada@example.edu",
    password: "correct horse battery staple",
  },
};

function createTestBackend() {
  const backend = convexTest(schema, modules);
  betterAuthTest.register(backend);
  return backend;
}

beforeEach(() => {
  process.env.SITE_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET = "test-secret-that-is-at-least-32-characters";
  process.env.DEVELOPER_PROVISIONING_SECRET = "developer-test-secret";
});

describe("provisioned identity boundary", () => {
  it("provisions an Organization and first Teacher with a usable credential", async () => {
    const backend = createTestBackend();
    const provisionResponse = await backend.fetch("/api/developer/provision-organization", {
      method: "POST",
      headers: {
        authorization: "Bearer developer-test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify(provisioningRequest),
    });

    expect(provisionResponse.status).toBe(201);
    const provisioned = (await provisionResponse.json()) as { authUserId: string };

    const signInResponse = await backend.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        email: provisioningRequest.teacher.email,
        password: provisioningRequest.teacher.password,
      }),
    });
    expect(signInResponse.status).toBe(200);

    const current = await backend
      .withIdentity({ subject: provisioned.authUserId })
      .query(api.users.current, {});
    expect(current).toMatchObject({
      displayName: "Ada Lovelace",
      username: "ada",
      email: "ada@example.edu",
      role: "teacher",
      organization: {
        name: "Example Academy",
        slug: "example-academy",
      },
    });

    const events = await backend.run(async (ctx) => await ctx.db.query("auditEvents").collect());
    expect(events.map((event) => event.action)).toEqual([
      "organization.provisioned",
      "user.provisioned",
      "user.teacher_role_assigned",
    ]);
  });

  it("rejects public signup and developer provisioning without the secret", async () => {
    const backend = createTestBackend();

    const signupResponse = await backend.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({
        name: "Public User",
        email: "public@example.edu",
        password: "password123",
      }),
    });
    expect(signupResponse.status).toBe(400);

    const provisioningResponse = await backend.fetch("/api/developer/provision-organization", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(provisioningRequest),
    });
    expect(provisioningResponse.status).toBe(404);
  });

  it("rejects unauthenticated and unprovisioned identities", async () => {
    const backend = createTestBackend();

    await expect(backend.query(api.users.current, {})).rejects.toThrow("Unauthenticated");
    await expect(
      backend.withIdentity({ subject: "unknown-auth-user" }).query(api.users.current, {}),
    ).rejects.toThrow("User is not provisioned");
  });
});
