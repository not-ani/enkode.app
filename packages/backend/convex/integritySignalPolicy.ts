import type { ReplayEvent, ReplayFile } from "./workHistoryReplayModel";

export const integritySignalThresholds = {
  largePasteCharacters: 200,
  largePasteContribution: 0.5,
  largePasteContributionMinimumCharacters: 40,
  unattributedBulkChangeCharacters: 200,
} as const;

export type EventSignalCandidate = {
  type: "large_paste" | "unattributed_bulk_change";
  evidenceKey: string;
  eventSequence: number;
  path: string;
  insertedCharacters: number;
  deletedCharacters: number;
  resultingFileCharacters: number;
  contribution: number;
};

function applyChanges(content: string, event: Extract<ReplayEvent, { type: "file_change" }>) {
  for (const change of [...event.changes].sort(
    (left, right) => right.rangeOffset - left.rangeOffset,
  )) {
    content =
      content.slice(0, change.rangeOffset) +
      change.text +
      content.slice(change.rangeOffset + change.rangeLength);
  }
  return content;
}

/** Produces neutral evidence candidates from authoritative, reconstructable events. */
export function eventSignalCandidates(
  workspaceId: string,
  baseline: ReplayFile[],
  events: ReplayEvent[],
) {
  const files = new Map(baseline.map(({ path, content }) => [path, content]));
  const candidates: EventSignalCandidate[] = [];

  for (const event of events) {
    if (event.type === "workspace_state") {
      files.clear();
      for (const file of event.files) files.set(file.path, file.content);
      continue;
    }
    const previous = files.get(event.path);
    if (previous === undefined)
      throw new Error(`Work History references unknown file ${event.path}`);
    const next = applyChanges(previous, event);
    files.set(event.path, next);
    const insertedCharacters = event.changes.reduce((sum, change) => sum + change.text.length, 0);
    const deletedCharacters = event.changes.reduce((sum, change) => sum + change.rangeLength, 0);
    const contribution = next.length === 0 ? 0 : Math.min(1, insertedCharacters / next.length);
    const evidence = {
      eventSequence: event.sequence,
      path: event.path,
      insertedCharacters,
      deletedCharacters,
      resultingFileCharacters: next.length,
      contribution,
    };
    if (
      event.origin === "paste" &&
      (insertedCharacters >= integritySignalThresholds.largePasteCharacters ||
        (insertedCharacters >= integritySignalThresholds.largePasteContributionMinimumCharacters &&
          contribution >= integritySignalThresholds.largePasteContribution))
    ) {
      candidates.push({
        type: "large_paste",
        evidenceKey: `${workspaceId}:large_paste:${event.sequence}`,
        ...evidence,
      });
    }
    if (
      event.origin === "unattributed" &&
      insertedCharacters + deletedCharacters >=
        integritySignalThresholds.unattributedBulkChangeCharacters
    ) {
      candidates.push({
        type: "unattributed_bulk_change",
        evidenceKey: `${workspaceId}:unattributed_bulk_change:${event.sequence}`,
        ...evidence,
      });
    }
  }
  return candidates;
}

export function transitionIntegritySignal(
  current: "open" | "reviewed" | "dismissed",
  next: "reviewed" | "dismissed",
) {
  if (current !== "open") throw new Error("Integrity Signal review is already complete");
  return next;
}
