import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

export type StarterFile = { path: string; content: string; order?: number };
export type MergeDecision = {
  path: string;
  choice: "keep_current" | "accept_new";
};

export function changedStarterFiles(fromFiles: StarterFile[], toFiles: StarterFile[]) {
  const from = new Map(fromFiles.map((file) => [file.path, file.content]));
  const to = new Map(toFiles.map((file) => [file.path, file.content]));
  return [...new Set([...from.keys(), ...to.keys()])]
    .filter((path) => from.get(path) !== to.get(path))
    .map((path) => ({
      path,
      kind: !from.has(path)
        ? ("added" as const)
        : !to.has(path)
          ? ("removed" as const)
          : ("modified" as const),
      previousContent: from.get(path),
      incomingContent: to.get(path),
    }));
}

export function applyStarterMerge(
  currentFiles: StarterFile[],
  fromFiles: StarterFile[],
  toFiles: StarterFile[],
  decisions: MergeDecision[],
) {
  const changed = changedStarterFiles(fromFiles, toFiles);
  const decisionByPath = new Map(decisions.map((decision) => [decision.path, decision.choice]));
  if (
    decisionByPath.size !== decisions.length ||
    changed.length !== decisions.length ||
    changed.some(({ path }) => !decisionByPath.has(path))
  ) {
    throw new Error("Choose how to handle every changed starter file");
  }

  const next = new Map(currentFiles.map((file) => [file.path, file.content]));
  const incoming = new Map(toFiles.map((file) => [file.path, file.content]));
  for (const { path } of changed) {
    if (decisionByPath.get(path) !== "accept_new") continue;
    const content = incoming.get(path);
    if (content === undefined) next.delete(path);
    else next.set(path, content);
  }
  const targetOrder = toFiles.map(({ path }) => path);
  return [...next]
    .sort(([left], [right]) => {
      const leftIndex = targetOrder.indexOf(left);
      const rightIndex = targetOrder.indexOf(right);
      if (leftIndex === -1 && rightIndex === -1) return 0;
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    })
    .map(([path, content]) => ({ path, content }));
}

export async function starterFilesFor(
  ctx: QueryCtx,
  assignmentVersionId: Id<"assignmentVersions">,
) {
  return await ctx.db
    .query("assignmentStarterFiles")
    .withIndex("by_version", (index) => index.eq("assignmentVersionId", assignmentVersionId))
    .collect();
}

export async function mergePlan(
  ctx: QueryCtx,
  fromVersion: Doc<"assignmentVersions">,
  toVersion: Doc<"assignmentVersions">,
) {
  const [fromFiles, toFiles, fromTests, toTests] = await Promise.all([
    starterFilesFor(ctx, fromVersion._id),
    starterFilesFor(ctx, toVersion._id),
    ctx.db
      .query("evaluationTests")
      .withIndex("by_version", (index) => index.eq("assignmentVersionId", fromVersion._id))
      .collect(),
    ctx.db
      .query("evaluationTests")
      .withIndex("by_version", (index) => index.eq("assignmentVersionId", toVersion._id))
      .collect(),
  ]);
  return {
    fromVersion: {
      assignmentVersionId: fromVersion._id,
      version: fromVersion.version,
      instructions: fromVersion.instructions,
      runtimeVersion: fromVersion.runtimeVersion,
      entrypoint: fromVersion.entrypoint,
      evaluationTests: fromTests,
    },
    toVersion: {
      assignmentVersionId: toVersion._id,
      version: toVersion.version,
      instructions: toVersion.instructions,
      runtimeVersion: toVersion.runtimeVersion,
      entrypoint: toVersion.entrypoint,
      evaluationTests: toTests,
    },
    changedStarterFiles: changedStarterFiles(fromFiles, toFiles),
  };
}
