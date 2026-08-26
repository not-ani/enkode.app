import { describe, expect, it } from "vitest";

import {
  eventSignalCandidates,
  integritySignalThresholds,
  transitionIntegritySignal,
} from "./integritySignalPolicy";

const baseline = [{ path: "main.py", content: "x".repeat(100) }];

function change(sequence: number, origin: "paste" | "unattributed", insertedCharacters: number) {
  return {
    sequence,
    type: "file_change" as const,
    path: "main.py",
    changes: [{ rangeOffset: 100, rangeLength: 0, text: "y".repeat(insertedCharacters) }],
    origin,
    observedAt: sequence,
  };
}

describe("Integrity Signal policy", () => {
  it("maintains explicit inclusive size and contribution thresholds for Large Paste", () => {
    const bySize = eventSignalCandidates("workspace", baseline, [
      change(1, "paste", integritySignalThresholds.largePasteCharacters),
    ]);
    expect(bySize).toEqual([expect.objectContaining({ type: "large_paste", eventSequence: 1 })]);

    const belowBoth = eventSignalCandidates("workspace", baseline, [change(1, "paste", 39)]);
    expect(belowBoth).toEqual([]);

    const byContribution = eventSignalCandidates("workspace", baseline, [change(2, "paste", 100)]);
    expect(byContribution).toEqual([
      expect.objectContaining({
        type: "large_paste",
        eventSequence: 2,
        contribution: 0.5,
      }),
    ]);
  });

  it("requires both unattributed origin and the maintained bulk-change threshold", () => {
    expect(
      eventSignalCandidates("workspace", baseline, [
        change(1, "unattributed", integritySignalThresholds.unattributedBulkChangeCharacters - 1),
      ]),
    ).toEqual([]);
    expect(
      eventSignalCandidates("workspace", baseline, [
        change(2, "unattributed", integritySignalThresholds.unattributedBulkChangeCharacters),
      ]),
    ).toEqual([expect.objectContaining({ type: "unattributed_bulk_change", eventSequence: 2 })]);
  });

  it("allows one neutral terminal review transition", () => {
    expect(transitionIntegritySignal("open", "reviewed")).toBe("reviewed");
    expect(transitionIntegritySignal("open", "dismissed")).toBe("dismissed");
    expect(() => transitionIntegritySignal("reviewed", "dismissed")).toThrow("already complete");
  });
});
