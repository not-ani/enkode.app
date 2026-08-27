import { describe, expect, it } from "vitest";

import { compareSubmissionFiles } from "./similarityComparison";

const starter = [
  { path: "main.py", content: "def solve(values):\n    # Student code\n    pass\n" },
];

describe("submission similarity comparison", () => {
  it("excludes unchanged starter code", () => {
    expect(compareSubmissionFiles(starter, starter, starter)).toEqual([]);
  });

  it("returns deterministic exact spans for meaningful student-authored overlap", () => {
    const copied =
      "def normalize_scores(scores):\n    maximum = max(scores)\n    return [round(score / maximum, 3) for score in scores]\n";
    const left = [{ path: "main.py", content: `${starter[0]!.content}\n${copied}` }];
    const right = [{ path: "helpers.py", content: `# moved helper\n${copied}` }];

    const first = compareSubmissionFiles(left, right, starter);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      path: "main.py",
      relatedPath: "helpers.py",
      text: copied.trim(),
    });
    expect(left[0]!.content.slice(first[0]!.start, first[0]!.end)).toBe(first[0]!.text);
    expect(right[0]!.content.slice(first[0]!.relatedStart, first[0]!.relatedEnd)).toBe(
      first[0]!.text,
    );
    expect(compareSubmissionFiles(left, right, starter)).toEqual(first);
  });

  it("does not report short incidental overlap", () => {
    expect(
      compareSubmissionFiles(
        [{ path: "main.py", content: "print('hello')\n" }],
        [{ path: "main.py", content: "print('hello')\n" }],
        [],
      ),
    ).toEqual([]);
  });
});
