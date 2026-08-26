import { ConvexError } from "convex/values";

import type { MutationCtx, QueryCtx } from "./_generated/server";

export const maintainedPythonRuntime = {
  language: "python" as const,
  version: "3.12.0",
};

export const maintainedJavaRuntime = {
  language: "java" as const,
  version: "15.0.2",
};

export const maintainedRuntimes = [maintainedPythonRuntime, maintainedJavaRuntime] as const;
export type SupportedLanguage = (typeof maintainedRuntimes)[number]["language"];
export type MaintainedRuntime = (typeof maintainedRuntimes)[number];

export function requireMaintainedRuntime(language: SupportedLanguage, version: string) {
  const runtime = maintainedRuntimes.find(
    (candidate) => candidate.language === language && candidate.version === version,
  );
  if (!runtime) {
    const name = language === "java" ? "Java" : "Python";
    throw new ConvexError(`Select an exactly pinned maintained ${name} runtime`);
  }
  return runtime;
}

export function requireMaintainedPythonRuntime(version: string) {
  return requireMaintainedRuntime("python", version);
}

export async function runtimeCanBeRemoved(ctx: MutationCtx | QueryCtx, runtime: MaintainedRuntime) {
  const reference = await ctx.db
    .query("assignmentVersions")
    .withIndex("by_runtime", (index) =>
      index.eq("language", runtime.language).eq("runtimeVersion", runtime.version),
    )
    .first();
  return reference === null;
}
