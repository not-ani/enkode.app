import { describe, expect, it, vi } from "vitest";

import { normalizePistonResponse, pistonRequest, PistonExecutionService } from "./execution";

const request = {
  runtime: { language: "python" as const, version: "3.12.0" },
  entrypoint: "src/main.py",
  files: [
    { path: "helpers.py", content: "answer = 42\n" },
    { path: "src/main.py", content: "from helpers import answer\nprint(answer)\n" },
  ],
  stdin: "question\n",
};

describe("Piston execution contract", () => {
  it("normalizes an exact pinned runtime, entrypoint-first multi-file request", () => {
    expect(pistonRequest(request)).toEqual({
      language: "python",
      version: "3.12.0",
      files: [
        { name: "src/main.py", content: "from helpers import answer\nprint(answer)\n" },
        { name: "helpers.py", content: "answer = 42\n" },
      ],
      stdin: "question\n",
      compile_timeout: 10_000,
      run_timeout: 3_000,
    });
  });

  it("posts to the configured compatible endpoint", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ run: { stdout: "42\n", stderr: "", code: 0, signal: null } }),
        ),
    );
    const service = new PistonExecutionService("https://piston.fork.test/root/", fetcher);

    await expect(service.execute(request)).resolves.toMatchObject({
      status: "completed",
      stdout: "42\n",
      exitCode: 0,
    });
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://piston.fork.test/api/v2/execute"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("normalizes runtime, compilation, and timeout responses", () => {
    expect(
      normalizePistonResponse({
        compile: { stdout: "", stderr: "SyntaxError", code: 1, signal: null },
        run: { stdout: "not run", stderr: "", code: 0, signal: null },
      }),
    ).toEqual({
      status: "failed",
      stdout: "",
      stderr: "SyntaxError",
      exitCode: 1,
      signal: null,
    });
    expect(
      normalizePistonResponse({
        run: { stdout: "partial", stderr: "", code: null, signal: "SIGKILL" },
      }),
    ).toEqual({
      status: "timed_out",
      stdout: "partial",
      stderr: "",
      exitCode: null,
      signal: "SIGKILL",
    });
  });
});
