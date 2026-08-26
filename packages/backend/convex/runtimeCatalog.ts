import { ConvexError } from "convex/values";

import type { MutationCtx, QueryCtx } from "./_generated/server";

export const maintainedPythonRuntime = {
  language: "python" as const,
  version: "3.12.0",
};

export function requireMaintainedPythonRuntime(version: string) {
  if (version !== maintainedPythonRuntime.version) {
    throw new ConvexError("Select an exactly pinned maintained Python runtime");
  }
  return maintainedPythonRuntime;
}

export async function runtimeCanBeRemoved(
  ctx: MutationCtx | QueryCtx,
  runtime: typeof maintainedPythonRuntime,
) {
  const reference = await ctx.db
    .query("assignmentVersions")
    .withIndex("by_runtime", (index) =>
      index.eq("language", runtime.language).eq("runtimeVersion", runtime.version),
    )
    .first();
  return reference === null;
}
