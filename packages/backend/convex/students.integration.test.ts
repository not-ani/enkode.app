import betterAuthTest from "@convex-dev/better-auth/test";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it } from "vitest";

import { api, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { studentCredentialEmail } from "./studentCredentials";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTestBackend() {
  const backend = convexTest(schema, modules);
  betterAuthTest.register(backend);
  return backend;
}

async function provisionOrganization(
  backend: ReturnType<typeof createTestBackend>,
  organization: { name: string; slug: string },
  teacher: { email: string; name: string; password: string; username: string },
) {
  const response = await backend.fetch("/api/developer/provision-organization", {
    method: "POST",
    headers: {
      authorization: "Bearer developer-test-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ organization, teacher }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    authUserId: string;
    organizationId: string;
    teacherId: string;
  };
}

async function signIn(
  backend: ReturnType<typeof createTestBackend>,
  email: string,
  password: string,
) {
  return await backend.fetch("/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
    },
    body: JSON.stringify({ email, password }),
  });
}

async function authenticatedIdentity(
  backend: ReturnType<typeof createTestBackend>,
  authUserId: string,
  email: string,
  password: string,
) {
  const response = await signIn(backend, email, password);
  expect(response.status).toBe(200);
  const session = (await backend.query(components.betterAuth.adapter.findOne, {
    model: "session",
    where: [{ field: "userId", value: authUserId }],
  })) as { _id: string };
  return { email, sessionId: session._id, subject: authUserId };
}

beforeEach(() => {
  process.env.SITE_URL = "http://localhost:3000";
  process.env.BETTER_AUTH_SECRET = "test-secret-that-is-at-least-32-characters";
  process.env.DEVELOPER_PROVISIONING_SECRET = "developer-test-secret";
});

describe("Student credentials", () => {
  it("provisions an optional-email Student who can sign in to the correct Organization", async () => {
    const backend = createTestBackend();
    const firstTeacher = await provisionOrganization(
      backend,
      { name: "Example Academy", slug: "example-academy" },
      {
        name: "Ada Lovelace",
        username: "ada",
        email: "ada@example.edu",
        password: "teacher password",
      },
    );
    const secondTeacher = await provisionOrganization(
      backend,
      { name: "Other Academy", slug: "other-academy" },
      {
        name: "Grace Hopper",
        username: "grace",
        email: "grace@other.edu",
        password: "teacher password",
      },
    );

    const firstStudent = await backend
      .withIdentity({ subject: firstTeacher.authUserId })
      .action(api.students.provision, {
        displayName: "Sam Student",
        password: "student password",
        username: "sam",
      });
    await backend
      .withIdentity({ subject: secondTeacher.authUserId })
      .action(api.students.provision, {
        displayName: "Other Sam",
        email: "sam@other.edu",
        password: "other password",
        username: "sam",
      });

    const login = await signIn(
      backend,
      studentCredentialEmail("example-academy", "sam"),
      "student password",
    );
    expect(login.status).toBe(200);
    const loggedIn = (await login.json()) as { user: { id: string } };
    const current = await backend
      .withIdentity({ subject: loggedIn.user.id })
      .query(api.users.current, {});
    expect(current).toMatchObject({
      id: firstStudent.id,
      displayName: "Sam Student",
      username: "sam",
      role: "student",
      organization: { name: "Example Academy", slug: "example-academy" },
    });
    expect(current).not.toHaveProperty("email");
    const listed = await backend
      .withIdentity({ subject: firstTeacher.authUserId })
      .query(api.students.list, {});
    expect(listed).toEqual([{ id: firstStudent.id, displayName: "Sam Student", username: "sam" }]);
    expect(listed.some((entry: object) => "password" in entry)).toBe(false);
  });

  it("enforces organization-scoped uniqueness and Teacher authorization", async () => {
    const backend = createTestBackend();
    const teacher = await provisionOrganization(
      backend,
      { name: "Example Academy", slug: "example-academy" },
      {
        name: "Ada Lovelace",
        username: "ada",
        email: "ada@example.edu",
        password: "teacher password",
      },
    );
    const student = await backend
      .withIdentity({ subject: teacher.authUserId })
      .action(api.students.provision, {
        displayName: "Sam Student",
        password: "student password",
        username: "SAM",
      });
    const studentId = student.id as Id<"users">;

    await expect(
      backend.withIdentity({ subject: teacher.authUserId }).action(api.students.provision, {
        displayName: "Duplicate Sam",
        password: "another password",
        username: "sam",
      }),
    ).rejects.toThrow("Username is already in use in this organization");

    const studentAuthUserId = await backend.run(async (ctx) => {
      const user = await ctx.db.get(studentId);
      return user?.authUserId;
    });
    if (!studentAuthUserId) throw new Error("Expected provisioned Student auth identity");
    await expect(
      backend.withIdentity({ subject: studentAuthUserId }).action(api.students.provision, {
        displayName: "Unauthorized Student",
        password: "another password",
        username: "unauthorized",
      }),
    ).rejects.toThrow("Forbidden");
  });

  it("lets only a same-Organization Teacher replace a Student password and audits both actions", async () => {
    const backend = createTestBackend();
    const teacher = await provisionOrganization(
      backend,
      { name: "Example Academy", slug: "example-academy" },
      {
        name: "Ada Lovelace",
        username: "ada",
        email: "ada@example.edu",
        password: "teacher password",
      },
    );
    const otherTeacher = await provisionOrganization(
      backend,
      { name: "Other Academy", slug: "other-academy" },
      {
        name: "Grace Hopper",
        username: "grace",
        email: "grace@other.edu",
        password: "teacher password",
      },
    );
    const teacherIdentity = await authenticatedIdentity(
      backend,
      teacher.authUserId,
      "ada@example.edu",
      "teacher password",
    );
    const otherTeacherIdentity = await authenticatedIdentity(
      backend,
      otherTeacher.authUserId,
      "grace@other.edu",
      "teacher password",
    );
    const student = await backend.withIdentity(teacherIdentity).action(api.students.provision, {
      displayName: "Sam Student",
      email: "sam@example.edu",
      password: "student password",
      username: "sam",
    });

    await expect(
      backend.withIdentity(otherTeacherIdentity).action(api.students.resetPassword, {
        password: "stolen password",
        studentId: student.id,
      }),
    ).rejects.toThrow("Forbidden");

    await backend.withIdentity(teacherIdentity).action(api.students.resetPassword, {
      password: "replacement password",
      studentId: student.id,
    });
    expect(
      await signIn(backend, studentCredentialEmail("example-academy", "sam"), "student password"),
    ).toMatchObject({ status: 401 });
    expect(
      await signIn(
        backend,
        studentCredentialEmail("example-academy", "sam"),
        "replacement password",
      ),
    ).toMatchObject({ status: 200 });

    const events = await backend.run(
      async (ctx) =>
        await ctx.db
          .query("auditEvents")
          .withIndex("by_target", (q) => q.eq("targetKind", "user").eq("targetId", student.id))
          .collect(),
    );
    expect(events.map((event) => event.action)).toEqual([
      "user.provisioned",
      "user.student_role_assigned",
      "user.password_reset",
    ]);
    expect(events.every((event) => event.actorUserId === teacher.teacherId)).toBe(true);
    expect(events.some((event) => "password" in event)).toBe(false);
  });
});
