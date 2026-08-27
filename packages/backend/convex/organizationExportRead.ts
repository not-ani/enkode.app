import { ConvexError, v } from "convex/values";

import { internalQuery } from "./_generated/server";

export const readOrganizationSnapshot = internalQuery({
  args: { organizationSlug: v.string() },
  handler: async (ctx, { organizationSlug }) => {
    const organization = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (index) => index.eq("slug", organizationSlug))
      .unique();
    if (!organization) throw new ConvexError("Organization not found");
    const organizationId = organization._id;
    const scoped = <Result>(query: { collect(): Promise<Result[]> }) => query.collect();

    // A Convex query observes one transactional snapshot. Keep every export table
    // in this single read so pagination or later object reads cannot mix metadata revisions.
    const [
      users,
      courses,
      courseCollaborators,
      courseLibraryItems,
      assignments,
      assignmentVersions,
      assignmentStarterFiles,
      evaluationTests,
      materials,
      materialAttachments,
      materialVersions,
      classrooms,
      classroomTeachers,
      enrollments,
      assignmentReleases,
      assignmentReleaseAdoptions,
      deadlineExceptions,
      assignmentExcuses,
      materialReleases,
      workspaces,
      workspaceVersionMerges,
      workHistoryChunks,
      workspaceAssignmentVersionMergeEvents,
      runs,
      submissionSnapshots,
      submissions,
      integritySignals,
      grades,
      gradeReturns,
      notifications,
      auditEvents,
    ] = await Promise.all([
      scoped(
        ctx.db
          .query("users")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("courses")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("courseCollaborators")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("courseLibraryItems")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("assignments")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("assignmentVersions")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("assignmentStarterFiles")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("evaluationTests")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("materials")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("materialAttachments")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("materialVersions")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("classrooms")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("classroomTeachers")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("enrollments")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("assignmentReleases")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("assignmentReleaseAdoptions")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("deadlineExceptions")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("assignmentExcuses")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("materialReleases")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("workspaces")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("workspaceVersionMerges")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("workHistoryChunks")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("workspaceAssignmentVersionMergeEvents")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("runs")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("submissionSnapshots")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("submissions")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("integritySignals")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("grades")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("gradeReturns")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("notifications")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
      scoped(
        ctx.db
          .query("auditEvents")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId)),
      ),
    ]);

    return {
      organization,
      records: {
        users,
        courses,
        courseCollaborators,
        courseLibraryItems,
        assignments,
        assignmentVersions,
        assignmentStarterFiles,
        evaluationTests,
        materials,
        materialAttachments,
        materialVersions,
        classrooms,
        classroomTeachers,
        enrollments,
        assignmentReleases,
        assignmentReleaseAdoptions,
        deadlineExceptions,
        assignmentExcuses,
        materialReleases,
        workspaces,
        workspaceVersionMerges,
        workHistoryChunks,
        workspaceAssignmentVersionMergeEvents,
        runs,
        submissionSnapshots,
        submissions,
        integritySignals,
        grades,
        gradeReturns,
        notifications,
        auditEvents,
      },
    };
  },
});
