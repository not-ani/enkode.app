import { ConvexError } from "convex/values";

import type { MutationCtx, QueryCtx } from "./_generated/server";

export const maintainedRuntimes = [
  {
    language: "python" as const,
    version: "3.12.0",
  },
  {
    language: "javascript" as const,
    version: "22.14.0",
  },
  {
    language: "typescript" as const,
    version: "5.0.3",
  },
] as const;

export type AssignmentLanguage = (typeof maintainedRuntimes)[number]["language"];
export type MaintainedRuntime = (typeof maintainedRuntimes)[number];

export const maintainedPythonRuntime = maintainedRuntimes[0];
export const maintainedJavaScriptRuntime = maintainedRuntimes[1];
export const maintainedTypeScriptRuntime = maintainedRuntimes[2];

export function requireMaintainedRuntime(language: AssignmentLanguage, version: string) {
  const runtime = maintainedRuntimes.find(
    (candidate) => candidate.language === language && candidate.version === version,
  );
  if (!runtime) {
    throw new ConvexError(`Select an exactly pinned maintained ${languageLabel(language)} runtime`);
  }
  return runtime;
}

function languageLabel(language: AssignmentLanguage) {
  return {
    python: "Python",
    javascript: "JavaScript",
    typescript: "TypeScript",
  }[language];
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
