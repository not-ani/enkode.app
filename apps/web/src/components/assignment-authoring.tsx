import { api } from "@enkode.app/backend/convex/_generated/api";
import { Button } from "@enkode.app/ui/components/button";
import { Input } from "@enkode.app/ui/components/input";
import { Textarea } from "@enkode.app/ui/components/textarea";
import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";

type AssignmentSummary = { _id: string; title: string; latestVersion: number };
type TestKind = "input_output" | "python_harness";
type Visibility = "public" | "hidden";
type StarterFile = { id: string; path: string; content: string };
type EvaluationTest = {
  id: string;
  name: string;
  kind: TestKind;
  visibility: Visibility;
  weight: string;
  stdin: string;
  expectedOutput: string;
  harness: string;
  passGuidance: string;
  failGuidance: string;
};

let fieldId = 0;
function nextId() {
  fieldId += 1;
  return String(fieldId);
}

function newFile(path = ""): StarterFile {
  return { id: nextId(), path, content: "" };
}

function newTest(): EvaluationTest {
  return {
    id: nextId(),
    name: "",
    kind: "input_output",
    visibility: "public",
    weight: "1",
    stdin: "",
    expectedOutput: "",
    harness: "",
    passGuidance: "",
    failGuidance: "",
  };
}

function initialDraft() {
  return {
    title: "",
    instructions: "",
    entrypoint: "main.py",
    files: [newFile("main.py"), newFile("helpers.py")],
    tests: [newTest()],
  };
}

export default function AssignmentAuthoring({ courseId }: { courseId: string }) {
  const assignments = useQuery(api.assignments.listByCourse, { courseId }) as
    | AssignmentSummary[]
    | undefined;
  const runtime = useQuery(api.assignments.supportedRuntime, { courseId }) as
    | { language: "python"; version: string }
    | undefined;
  const createAssignment = useMutation(api.assignments.create);
  const createVersion = useMutation(api.assignments.createVersion);
  const [draft, setDraft] = useState(initialDraft);
  const [versioning, setVersioning] = useState<AssignmentSummary>();
  const [authoring, setAuthoring] = useState(false);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  function updateFile(id: string, changes: Partial<StarterFile>) {
    setDraft((current) => ({
      ...current,
      files: current.files.map((file) => (file.id === id ? { ...file, ...changes } : file)),
    }));
  }

  function updateTest(id: string, changes: Partial<EvaluationTest>) {
    setDraft((current) => ({
      ...current,
      tests: current.tests.map((test) => (test.id === id ? { ...test, ...changes } : test)),
    }));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!runtime) return;
    setSaving(true);
    setError(undefined);
    const version = {
      instructions: draft.instructions,
      runtimeVersion: runtime.version,
      entrypoint: draft.entrypoint,
      starterFiles: draft.files.map(({ path, content }) => ({ path, content })),
      evaluationTests: draft.tests.map((test) => ({
        name: test.name,
        kind: test.kind,
        visibility: test.visibility,
        weight: Number(test.weight),
        stdin: test.kind === "input_output" ? test.stdin : undefined,
        expectedOutput: test.kind === "input_output" ? test.expectedOutput : undefined,
        harness: test.kind === "python_harness" ? test.harness : undefined,
        passGuidance: test.passGuidance || undefined,
        failGuidance: test.failGuidance || undefined,
      })),
    };
    try {
      if (versioning) await createVersion({ assignmentId: versioning._id, ...version });
      else await createAssignment({ courseId, title: draft.title, ...version });
      setDraft(initialDraft());
      setVersioning(undefined);
      setAuthoring(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save Assignment Version");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 border-l-2 border-foreground/10 pl-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-medium text-base sm:text-sm">Assignments</p>
          <p className="text-muted-foreground text-base sm:text-sm">
            Immutable Python content for this Course.
          </p>
        </div>
        {authoring ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setVersioning(undefined);
              setAuthoring(false);
            }}
          >
            Cancel
          </Button>
        ) : null}
      </div>

      {assignments?.length ? (
        <ul className="flex flex-col gap-2" role="list">
          {assignments.map((assignment) => (
            <li
              className="flex items-center justify-between gap-3 text-base sm:text-sm"
              key={assignment._id}
            >
              <span className="min-w-0 truncate">
                {assignment.title}{" "}
                <span className="text-muted-foreground">v{assignment.latestVersion}</span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setVersioning(assignment);
                  setDraft(initialDraft());
                  setAuthoring(true);
                }}
              >
                New version
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {!authoring ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="self-start"
          onClick={() => {
            setVersioning(undefined);
            setDraft(initialDraft());
            setAuthoring(true);
          }}
        >
          Author Assignment
        </Button>
      ) : (
        <form className="flex flex-col gap-5" onSubmit={save}>
          <div className="grid gap-3 @md:grid-cols-2">
            {versioning ? (
              <p className="font-medium text-base sm:text-sm">New version of {versioning.title}</p>
            ) : (
              <label className="flex flex-col gap-1.5 text-base sm:text-sm">
                Assignment title
                <Input
                  required
                  value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                />
              </label>
            )}
            <label className="flex flex-col gap-1.5 text-base sm:text-sm">
              Fixed entrypoint
              <Input
                required
                value={draft.entrypoint}
                onChange={(event) => setDraft({ ...draft, entrypoint: event.target.value })}
              />
            </label>
          </div>
          <p className="text-muted-foreground text-base sm:text-sm">
            Runtime: Python {runtime?.version ?? "loading…"} (exactly pinned)
          </p>
          <label className="flex flex-col gap-1.5 text-base sm:text-sm">
            Instructions
            <Textarea
              required
              value={draft.instructions}
              onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
            />
          </label>

          <fieldset className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <legend className="font-medium text-base sm:text-sm">Starter files</legend>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setDraft({ ...draft, files: [...draft.files, newFile()] })}
              >
                Add file
              </Button>
            </div>
            {draft.files.map((file) => (
              <div className="grid gap-2 @md:grid-cols-[12rem_1fr_auto]" key={file.id}>
                <Input
                  aria-label="Starter file path"
                  required
                  value={file.path}
                  onChange={(event) => updateFile(file.id, { path: event.target.value })}
                />
                <Textarea
                  aria-label={`Contents of ${file.path || "starter file"}`}
                  value={file.content}
                  onChange={(event) => updateFile(file.id, { content: event.target.value })}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={draft.files.length === 1}
                  onClick={() =>
                    setDraft({ ...draft, files: draft.files.filter((item) => item.id !== file.id) })
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
          </fieldset>

          <fieldset className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <legend className="font-medium text-base sm:text-sm">Evaluation Tests</legend>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setDraft({ ...draft, tests: [...draft.tests, newTest()] })}
              >
                Add test
              </Button>
            </div>
            {draft.tests.map((test) => (
              <div className="bg-background grid gap-3 border p-3" key={test.id}>
                <div className="grid gap-2 @md:grid-cols-[1fr_10rem_8rem_6rem]">
                  <Input
                    aria-label="Evaluation Test name"
                    placeholder="Test name"
                    required
                    value={test.name}
                    onChange={(event) => updateTest(test.id, { name: event.target.value })}
                  />
                  <select
                    aria-label="Evaluation Test kind"
                    className="border-input bg-background h-8 border px-2 text-xs"
                    value={test.kind}
                    onChange={(event) =>
                      updateTest(test.id, { kind: event.target.value as TestKind })
                    }
                  >
                    <option value="input_output">Input/output</option>
                    <option value="python_harness">Python harness</option>
                  </select>
                  <select
                    aria-label="Evaluation Test visibility"
                    className="border-input bg-background h-8 border px-2 text-xs"
                    value={test.visibility}
                    onChange={(event) =>
                      updateTest(test.id, { visibility: event.target.value as Visibility })
                    }
                  >
                    <option value="public">Public</option>
                    <option value="hidden">Hidden</option>
                  </select>
                  <Input
                    aria-label="Point weight"
                    type="number"
                    min="0"
                    step="any"
                    required
                    value={test.weight}
                    onChange={(event) => updateTest(test.id, { weight: event.target.value })}
                  />
                </div>
                {test.kind === "input_output" ? (
                  <div className="grid gap-2 @md:grid-cols-2">
                    <Textarea
                      aria-label="Standard input"
                      placeholder="Standard input"
                      value={test.stdin}
                      onChange={(event) => updateTest(test.id, { stdin: event.target.value })}
                    />
                    <Textarea
                      aria-label="Expected output"
                      placeholder="Expected output"
                      value={test.expectedOutput}
                      onChange={(event) =>
                        updateTest(test.id, { expectedOutput: event.target.value })
                      }
                    />
                  </div>
                ) : (
                  <Textarea
                    aria-label="Python harness source"
                    placeholder="Python assertion or supported test harness"
                    required
                    value={test.harness}
                    onChange={(event) => updateTest(test.id, { harness: event.target.value })}
                  />
                )}
                <div className="grid gap-2 @md:grid-cols-2">
                  <Input
                    aria-label="Pass guidance"
                    placeholder="Pass guidance (optional)"
                    value={test.passGuidance}
                    onChange={(event) => updateTest(test.id, { passGuidance: event.target.value })}
                  />
                  <Input
                    aria-label="Fail guidance"
                    placeholder="Fail guidance (optional)"
                    value={test.failGuidance}
                    onChange={(event) => updateTest(test.id, { failGuidance: event.target.value })}
                  />
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="justify-self-end"
                  onClick={() =>
                    setDraft({ ...draft, tests: draft.tests.filter((item) => item.id !== test.id) })
                  }
                >
                  Remove test
                </Button>
              </div>
            ))}
          </fieldset>
          {error ? <p className="text-destructive text-base sm:text-sm">{error}</p> : null}
          <Button type="submit" className="self-start" disabled={saving || !runtime}>
            {saving ? "Saving…" : versioning ? "Create immutable version" : "Create Assignment"}
          </Button>
        </form>
      )}
    </div>
  );
}
