import { api as generatedApi } from "@enkode.app/backend/convex/_generated/api";
import type * as archive from "@enkode.app/backend/convex/archive";
import type * as assignmentReleases from "@enkode.app/backend/convex/assignmentReleases";
import type * as assignments from "@enkode.app/backend/convex/assignments";
import type * as audit from "@enkode.app/backend/convex/audit";
import type * as classrooms from "@enkode.app/backend/convex/classrooms";
import type * as courses from "@enkode.app/backend/convex/courses";
import type * as enrollments from "@enkode.app/backend/convex/enrollments";
import type * as gradebook from "@enkode.app/backend/convex/gradebook";
import type * as grades from "@enkode.app/backend/convex/grades";
import type * as healthCheck from "@enkode.app/backend/convex/healthCheck";
import type * as integritySignalEvidence from "@enkode.app/backend/convex/integritySignalEvidence";
import type * as integritySignals from "@enkode.app/backend/convex/integritySignals";
import type * as liveWorkspaces from "@enkode.app/backend/convex/liveWorkspaces";
import type * as materialReleases from "@enkode.app/backend/convex/materialReleases";
import type * as materials from "@enkode.app/backend/convex/materials";
import type * as materialUpload from "@enkode.app/backend/convex/materialUpload";
import type * as notifications from "@enkode.app/backend/convex/notifications";
import type * as runs from "@enkode.app/backend/convex/runs";
import type * as students from "@enkode.app/backend/convex/students";
import type * as submissions from "@enkode.app/backend/convex/submissions";
import type * as submissionUpload from "@enkode.app/backend/convex/submissionUpload";
import type * as users from "@enkode.app/backend/convex/users";
import type * as workHistoryReplay from "@enkode.app/backend/convex/workHistoryReplay";
import type * as workHistoryReplayRead from "@enkode.app/backend/convex/workHistoryReplayRead";
import type * as workHistoryUpload from "@enkode.app/backend/convex/workHistoryUpload";
import type * as workspaces from "@enkode.app/backend/convex/workspaces";
import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import type { GenericId } from "convex/values";

type WebApi = ApiFromModules<{
  archive: typeof archive;
  assignmentReleases: typeof assignmentReleases;
  assignments: typeof assignments;
  audit: typeof audit;
  classrooms: typeof classrooms;
  courses: typeof courses;
  enrollments: typeof enrollments;
  gradebook: typeof gradebook;
  grades: typeof grades;
  healthCheck: typeof healthCheck;
  integritySignalEvidence: typeof integritySignalEvidence;
  integritySignals: typeof integritySignals;
  liveWorkspaces: typeof liveWorkspaces;
  materialReleases: typeof materialReleases;
  materials: typeof materials;
  materialUpload: typeof materialUpload;
  notifications: typeof notifications;
  runs: typeof runs;
  students: typeof students;
  submissions: typeof submissions;
  submissionUpload: typeof submissionUpload;
  users: typeof users;
  workHistoryReplay: typeof workHistoryReplay;
  workHistoryReplayRead: typeof workHistoryReplayRead;
  workHistoryUpload: typeof workHistoryUpload;
  workspaces: typeof workspaces;
}>;

type StringifyIds<Value> =
  Value extends GenericId<string>
    ? string
    : Value extends readonly (infer Item)[]
      ? StringifyIds<Item>[]
      : Value extends object
        ? { [Key in keyof Value]: StringifyIds<Value[Key]> }
        : Value;

type WebBoundaryApi<Value> =
  Value extends FunctionReference<
    infer Type,
    infer Visibility,
    infer Args,
    infer Return,
    infer ComponentPath
  >
    ? FunctionReference<Type, Visibility, StringifyIds<Args>, StringifyIds<Return>, ComponentPath>
    : { [Key in keyof Value]: WebBoundaryApi<Value[Key]> };

export const api = generatedApi as WebBoundaryApi<
  FilterApi<WebApi, FunctionReference<"query" | "mutation" | "action", "public">>
>;
