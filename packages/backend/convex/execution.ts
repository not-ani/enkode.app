export type ExecutionFile = { path: string; content: string };

export type ExecutionRequest = {
  runtime: { language: "python"; version: string };
  entrypoint: string;
  files: ExecutionFile[];
  stdin?: string;
};

export type ExecutionResult = {
  status: "completed" | "failed" | "timed_out";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
};

export interface ExecutionService {
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const hostedExecutionEndpoint = "https://execute.enkode.app";

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stage(value: unknown) {
  const record = object(value);
  if (!record) return undefined;
  return {
    stdout: typeof record.stdout === "string" ? record.stdout : "",
    stderr: typeof record.stderr === "string" ? record.stderr : "",
    code: typeof record.code === "number" ? record.code : null,
    signal: typeof record.signal === "string" ? record.signal : null,
  };
}

export function pistonRequest(request: ExecutionRequest) {
  const entrypoint = request.files.find(({ path }) => path === request.entrypoint);
  if (!entrypoint) throw new Error("Execution entrypoint is missing from the Workspace");
  return {
    language: request.runtime.language,
    version: request.runtime.version,
    files: [entrypoint, ...request.files.filter(({ path }) => path !== request.entrypoint)].map(
      ({ path, content }) => ({ name: path, content }),
    ),
    stdin: request.stdin ?? "",
    compile_timeout: 10_000,
    run_timeout: 3_000,
  };
}

export function normalizePistonResponse(value: unknown): ExecutionResult {
  const response = object(value);
  if (!response) throw new Error("Execution service returned an invalid response");
  const compile = stage(response.compile);
  const run = stage(response.run);
  const selected = compile?.code && compile.code !== 0 ? compile : run;
  if (!selected) throw new Error("Execution service response did not include a run result");
  const stderr = [compile?.stderr, run?.stderr].filter(Boolean).join("\n");
  const timedOut = selected.signal === "SIGKILL" || selected.signal === "SIGTERM";
  return {
    status: timedOut ? "timed_out" : selected.code === 0 ? "completed" : "failed",
    stdout: selected.stdout,
    stderr,
    exitCode: selected.code,
    signal: selected.signal,
  };
}

export class PistonExecutionService implements ExecutionService {
  constructor(
    private readonly endpoint: string,
    private readonly request: Fetch = fetch,
  ) {}

  async execute(input: ExecutionRequest) {
    const response = await this.request(new URL("/api/v2/execute", this.endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pistonRequest(input)),
    });
    if (!response.ok) throw new Error(`Execution service request failed (${response.status})`);
    return normalizePistonResponse(await response.json());
  }
}

export class FakeExecutionService implements ExecutionService {
  readonly requests: ExecutionRequest[] = [];

  constructor(private readonly responses: ExecutionResult[]) {}

  async execute(request: ExecutionRequest) {
    this.requests.push(structuredClone(request));
    const response = this.responses.shift();
    if (!response) throw new Error("Fake execution response was not configured");
    return response;
  }
}

export function executionServiceFromEnvironment() {
  return new PistonExecutionService(
    process.env.ENKODE_EXECUTION_ENDPOINT?.trim() || hostedExecutionEndpoint,
  );
}
