import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { validateEvaluationTest, validateFilePath } from "./assignmentPolicy";
import { appendAuditEvent } from "./audit";
import { requireCourseCollaborator } from "./authorization";
import { requireWritableAssignment, requireWritableCourse } from "./lifecycleGuards";
import {
  maintainedPythonRuntime,
  maintainedRuntimes,
  requireMaintainedRuntime,
  type AssignmentLanguage,
} from "./runtimeCatalog";

const starterFile = v.object({ path: v.string(), content: v.string() });
const evaluationTest = v.object({
  name: v.string(),
  kind: v.union(
    v.literal("input_output"),
    v.literal("python_harness"),
    v.literal("javascript_harness"),
    v.literal("typescript_harness"),
    v.literal("java_harness"),
  ),
  visibility: v.union(v.literal("public"), v.literal("hidden")),
  weight: v.number(),
  stdin: v.optional(v.string()),
  expectedOutput: v.optional(v.string()),
  harness: v.optional(v.string()),
  passGuidance: v.optional(v.string()),
  failGuidance: v.optional(v.string()),
});
const versionFields = {
  language: v.optional(
    v.union(
      v.literal("python"),
      v.literal("javascript"),
      v.literal("typescript"),
      v.literal("java"),
    ),
  ),
  instructions: v.string(),
  runtimeVersion: v.string(),
  entrypoint: v.string(),
  starterFiles: v.array(starterFile),
  evaluationTests: v.array(evaluationTest),
};

type VersionInput = {
  language?: AssignmentLanguage;
  instructions: string;
  runtimeVersion: string;
  entrypoint: string;
  starterFiles: { path: string; content: string }[];
  evaluationTests: {
    name: string;
    kind:
      | "input_output"
      | "python_harness"
      | "javascript_harness"
      | "typescript_harness"
      | "java_harness";
    visibility: "public" | "hidden";
    weight: number;
    stdin?: string;
    expectedOutput?: string;
    harness?: string;
    passGuidance?: string;
    failGuidance?: string;
  }[];
};

function cleanRequired(value: string, label: string) {
  const cleaned = value.trim();
  if (!cleaned) throw new ConvexError(`${label} is required`);
  return cleaned;
}

function cleanOptional(value: string | undefined) {
  const cleaned = value?.trim();
  return cleaned || undefined;
}

function validateVersion(input: VersionInput) {
  const language = input.language ?? "python";
  const instructions = cleanRequired(input.instructions, "Instructions");
  const entrypoint = validateFilePath(input.entrypoint);
  requireMaintainedRuntime(language, input.runtimeVersion);
  if (input.starterFiles.length === 0) throw new ConvexError("Add at least one starter file");

  const paths = input.starterFiles.map(({ path }) => validateFilePath(path));
  if (new Set(paths).size !== paths.length)
    throw new ConvexError("Starter file paths must be unique");
  if (!paths.includes(entrypoint)) throw new ConvexError("The entrypoint must be a starter file");
  const extension = { python: ".py", javascript: ".js", typescript: ".ts", java: ".java" }[
    language
  ];
  if (!entrypoint.endsWith(extension)) {
    throw new ConvexError(`The ${language} entrypoint must end in ${extension}`);
  }
  input.evaluationTests.forEach((test) => validateEvaluationTest(test, language));
  return { instructions, entrypoint, language, paths };
}

async function insertVersion(
  ctx: MutationCtx,
  assignment: Doc<"assignments">,
  createdBy: Id<"users">,
  input: VersionInput,
) {
  const { entrypoint, instructions, language, paths } = validateVersion(input);
  const version = assignment.latestVersion + 1;
  const assignmentVersionId = await ctx.db.insert("assignmentVersions", {
    organizationId: assignment.organizationId,
    assignmentId: assignment._id,
    version,
    instructions,
    language,
    runtimeVersion: input.runtimeVersion,
    entrypoint,
    createdBy,
    createdAt: Date.now(),
  });
  await Promise.all(
    input.starterFiles.map((file, order) =>
      ctx.db.insert("assignmentStarterFiles", {
        organizationId: assignment.organizationId,
        assignmentVersionId,
        path: paths[order]!,
        content: file.content,
        order,
      }),
    ),
  );
  await Promise.all(
    input.evaluationTests.map((test, order) =>
      ctx.db.insert("evaluationTests", {
        organizationId: assignment.organizationId,
        assignmentVersionId,
        name: test.name.trim(),
        kind: test.kind,
        visibility: test.visibility,
        weight: test.weight,
        stdin: test.kind === "input_output" ? test.stdin : undefined,
        expectedOutput: test.kind === "input_output" ? test.expectedOutput : undefined,
        harness: test.kind === "input_output" ? undefined : test.harness?.trim(),
        passGuidance: cleanOptional(test.passGuidance),
        failGuidance: cleanOptional(test.failGuidance),
        order,
      }),
    ),
  );
  await ctx.db.patch(assignment._id, { latestVersion: version });
  return assignmentVersionId;
}

async function loadVersion(ctx: QueryCtx, assignmentVersionId: Id<"assignmentVersions">) {
  const version = await ctx.db.get(assignmentVersionId);
  if (!version) throw new ConvexError("Assignment Version not found");
  const starterFiles = await ctx.db
    .query("assignmentStarterFiles")
    .withIndex("by_version", (index) => index.eq("assignmentVersionId", assignmentVersionId))
    .collect();
  const evaluationTests = await ctx.db
    .query("evaluationTests")
    .withIndex("by_version", (index) => index.eq("assignmentVersionId", assignmentVersionId))
    .collect();
  return { ...version, starterFiles, evaluationTests };
}

export const supportedRuntime = query({
  args: { courseId: v.id("courses") },
  handler: async (ctx, { courseId }) => {
    await requireCourseCollaborator(ctx, courseId);
    return maintainedPythonRuntime;
  },
});

export const supportedRuntimes = query({
  args: { courseId: v.id("courses") },
  handler: async (ctx, { courseId }) => {
    await requireCourseCollaborator(ctx, courseId);
    return maintainedRuntimes;
  },
});

export const create = mutation({
  args: { courseId: v.id("courses"), title: v.string(), ...versionFields },
  handler: async (ctx, { courseId, title, ...versionInput }) => {
    const { organization, user } = await requireCourseCollaborator(ctx, courseId);
    await requireWritableCourse(ctx, courseId);
    const assignmentId = await ctx.db.insert("assignments", {
      organizationId: organization._id,
      courseId,
      title: cleanRequired(title, "Assignment title"),
      latestVersion: 0,
    });
    const assignment = await ctx.db.get(assignmentId);
    if (!assignment) throw new ConvexError("Assignment could not be created");
    const lastLibraryItem = await ctx.db
      .query("courseLibraryItems")
      .withIndex("by_course", (index) => index.eq("courseId", courseId))
      .order("desc")
      .first();
    await ctx.db.insert("courseLibraryItems", {
      organizationId: organization._id,
      courseId,
      kind: "assignment",
      assignmentId,
      order: (lastLibraryItem?.order ?? -1) + 1,
      createdAt: Date.now(),
    });
    const assignmentVersionId = await insertVersion(ctx, assignment, user._id, versionInput);
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "assignment.created",
      target: { kind: "assignment", id: assignmentId },
    });
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "assignment_version.created",
      target: { kind: "assignment_version", id: assignmentVersionId },
    });
    return { assignmentId, assignmentVersionId };
  },
});

export const createVersion = mutation({
  args: { assignmentId: v.id("assignments"), ...versionFields },
  handler: async (ctx, { assignmentId, ...versionInput }) => {
    const assignment = await requireWritableAssignment(ctx, assignmentId);
    const { organization, user } = await requireCourseCollaborator(ctx, assignment.courseId);
    const assignmentVersionId = await insertVersion(ctx, assignment, user._id, versionInput);
    await appendAuditEvent(ctx, {
      organizationId: organization._id,
      actor: { kind: "user", userId: user._id },
      action: "assignment_version.created",
      target: { kind: "assignment_version", id: assignmentVersionId },
    });
    return assignmentVersionId;
  },
});

export const listByCourse = query({
  args: { courseId: v.id("courses") },
  handler: async (ctx, { courseId }) => {
    await requireCourseCollaborator(ctx, courseId);
    const assignments = await ctx.db
      .query("assignments")
      .withIndex("by_course", (index) => index.eq("courseId", courseId))
      .collect();
    return assignments.filter(({ archivedAt }) => archivedAt === undefined);
  },
});

export const getVersion = query({
  args: { assignmentVersionId: v.id("assignmentVersions") },
  handler: async (ctx, { assignmentVersionId }) => {
    const version = await ctx.db.get(assignmentVersionId);
    if (!version) throw new ConvexError("Assignment Version not found");
    const assignment = await ctx.db.get(version.assignmentId);
    if (!assignment) throw new ConvexError("Assignment not found");
    await requireCourseCollaborator(ctx, assignment.courseId);
    return await loadVersion(ctx, assignmentVersionId);
  },
});
