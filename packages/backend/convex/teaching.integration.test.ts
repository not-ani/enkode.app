import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTestBackend() {
  return convexTest(schema, modules);
}

async function seedUsers(backend: ReturnType<typeof createTestBackend>) {
  return await backend.run(async (ctx) => {
    const northId = await ctx.db.insert("organizations", {
      name: "North Academy",
      slug: "north",
    });
    const southId = await ctx.db.insert("organizations", {
      name: "South Academy",
      slug: "south",
    });
    const adaId = await ctx.db.insert("users", {
      organizationId: northId,
      authUserId: "auth-ada",
      username: "ada",
      displayName: "Ada Lovelace",
      role: "teacher",
    });
    const graceId = await ctx.db.insert("users", {
      organizationId: northId,
      authUserId: "auth-grace",
      username: "grace",
      displayName: "Grace Hopper",
      role: "teacher",
    });
    const linusId = await ctx.db.insert("users", {
      organizationId: northId,
      authUserId: "auth-linus",
      username: "linus",
      displayName: "Linus Torvalds",
      role: "teacher",
    });
    await ctx.db.insert("users", {
      organizationId: northId,
      authUserId: "auth-student",
      username: "student",
      displayName: "North Student",
      role: "student",
    });
    const southTeacherId = await ctx.db.insert("users", {
      organizationId: southId,
      authUserId: "auth-south",
      username: "south-teacher",
      displayName: "South Teacher",
      role: "teacher",
    });
    return { adaId, graceId, linusId, northId, southId, southTeacherId };
  });
}

describe("Course and Classroom teaching assignments", () => {
  it("keeps Assignments and Materials in one reorderable Course library", async () => {
    const backend = createTestBackend();
    await seedUsers(backend);
    const ada = backend.withIdentity({ subject: "auth-ada" });
    const courseId = await ada.mutation(api.courses.create, { name: "CS101" });
    const assignment = await ada.mutation(api.assignments.create, {
      courseId,
      title: "Variables",
      instructions: "Declare a variable.",
      runtimeVersion: "3.12.0",
      entrypoint: "main.py",
      starterFiles: [{ path: "main.py", content: "" }],
      evaluationTests: [],
    });
    await ada.mutation(api.materials.create, {
      courseId,
      title: "Reference sheet",
      content: { kind: "rich_text", richText: "Variable syntax" },
    });

    const initial = await ada.query(api.courses.library, { courseId });
    expect(
      initial.map(({ kind, title }: { kind: string; title: string }) => [kind, title]),
    ).toEqual([
      ["assignment", "Variables"],
      ["material", "Reference sheet"],
    ]);
    await ada.mutation(api.courses.moveLibraryItem, {
      courseId,
      itemId: initial[1]!.id,
      direction: "up",
    });
    expect(
      (await ada.query(api.courses.library, { courseId })).map(
        ({ kind }: { kind: string }) => kind,
      ),
    ).toEqual(["material", "assignment"]);

    const events = await backend.run(async (ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_target", (index) =>
          index.eq("targetKind", "course").eq("targetId", courseId),
        )
        .collect(),
    );
    expect(events.map(({ action }) => action)).toContain("course.library_reordered");
    expect(assignment.assignmentId).toBeTruthy();
  });

  it("keeps Course Collaborator and Classroom Teacher access independent", async () => {
    const backend = createTestBackend();
    const { graceId, linusId } = await seedUsers(backend);
    const ada = backend.withIdentity({ subject: "auth-ada" });
    const courseId = await ada.mutation(api.courses.create, {
      name: "CS101",
      description: "Introduction to programming",
    });
    const classroomId = await ada.mutation(api.classrooms.create, {
      courseId,
      name: "Period 1 CS101",
    });

    await ada.mutation(api.courses.addCollaborator, { courseId, username: "grace" });
    await ada.mutation(api.classrooms.addTeacher, { classroomId, username: "linus" });

    const course = await backend
      .withIdentity({ subject: "auth-grace" })
      .query(api.courses.get, { courseId });
    expect(course.collaborators.map(({ username }: { username: string }) => username)).toEqual([
      "ada",
      "grace",
    ]);
    await expect(
      backend.withIdentity({ subject: "auth-grace" }).query(api.classrooms.get, { classroomId }),
    ).rejects.toThrow("Forbidden");

    const classroom = await backend
      .withIdentity({ subject: "auth-linus" })
      .query(api.classrooms.get, { classroomId });
    expect(classroom.course.name).toBe("CS101");
    expect(classroom.teachers.map(({ username }: { username: string }) => username)).toEqual([
      "ada",
      "linus",
    ]);
    await expect(
      backend.withIdentity({ subject: "auth-linus" }).query(api.courses.get, { courseId }),
    ).rejects.toThrow("Forbidden");

    await ada.mutation(api.courses.removeCollaborator, { courseId, teacherId: graceId });
    expect(
      await backend
        .withIdentity({ subject: "auth-linus" })
        .query(api.classrooms.get, { classroomId }),
    ).toMatchObject({ _id: classroomId });
    await ada.mutation(api.classrooms.removeTeacher, { classroomId, teacherId: linusId });
  });

  it("rejects unassigned, Student, and cross-Organization access", async () => {
    const backend = createTestBackend();
    const { adaId } = await seedUsers(backend);
    const ada = backend.withIdentity({ subject: "auth-ada" });
    const courseId = await ada.mutation(api.courses.create, { name: "CS101" });
    const classroomId = await ada.mutation(api.classrooms.create, {
      courseId,
      name: "Period 1",
    });

    for (const subject of ["auth-grace", "auth-south"]) {
      await expect(
        backend.withIdentity({ subject }).query(api.courses.get, { courseId }),
      ).rejects.toThrow("Forbidden");
      await expect(
        backend.withIdentity({ subject }).mutation(api.classrooms.update, {
          classroomId,
          name: "Changed",
        }),
      ).rejects.toThrow("Forbidden");
    }
    await expect(
      backend.withIdentity({ subject: "auth-student" }).mutation(api.courses.create, {
        name: "Student Course",
      }),
    ).rejects.toThrow("Forbidden");
    await expect(
      ada.mutation(api.courses.addCollaborator, { courseId, username: "south-teacher" }),
    ).rejects.toThrow("Teacher not found");
    await expect(
      ada.mutation(api.courses.removeCollaborator, {
        courseId,
        teacherId: adaId,
      }),
    ).rejects.toThrow("at least one Course Collaborator");
  });

  it("audits Course, Classroom, and assignment changes", async () => {
    const backend = createTestBackend();
    const { graceId, linusId } = await seedUsers(backend);
    const ada = backend.withIdentity({ subject: "auth-ada" });
    const courseId = await ada.mutation(api.courses.create, { name: "CS101" });
    await ada.mutation(api.courses.update, {
      courseId,
      name: "CS 101",
      description: "Programming foundations",
    });
    await ada.mutation(api.courses.addCollaborator, { courseId, username: "grace" });
    const classroomId = await ada.mutation(api.classrooms.create, {
      courseId,
      name: "Period 1",
    });
    await ada.mutation(api.classrooms.update, { classroomId, name: "Period 2" });
    await ada.mutation(api.classrooms.addTeacher, { classroomId, username: "linus" });
    await ada.mutation(api.courses.removeCollaborator, { courseId, teacherId: graceId });
    await ada.mutation(api.classrooms.removeTeacher, { classroomId, teacherId: linusId });

    const events = await backend.run(async (ctx) => await ctx.db.query("auditEvents").collect());
    expect(events.map((event) => event.action)).toEqual([
      "course.created",
      "course_collaborator.assigned",
      "course.updated",
      "course_collaborator.assigned",
      "classroom.created",
      "classroom_teacher.assigned",
      "classroom.updated",
      "classroom_teacher.assigned",
      "course_collaborator.unassigned",
      "classroom_teacher.unassigned",
    ]);
    expect(events.every((event) => event.actorUserId !== undefined)).toBe(true);
  });
});
