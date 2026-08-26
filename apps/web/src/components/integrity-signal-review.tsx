import { Button } from "@enkode.app/ui/components/button";
import { Textarea } from "@enkode.app/ui/components/textarea";
import { useState } from "react";

export type IntegritySignal = {
  _id: string;
  type: "large_paste" | "unattributed_bulk_change" | "work_history_gap";
  state: "open" | "reviewed" | "dismissed";
  eventSequence?: number;
  path?: string;
  insertedCharacters?: number;
  deletedCharacters?: number;
  contribution?: number;
  sequenceStart?: number;
  sequenceEnd?: number;
  gapReason?: string;
  teacherNote?: string;
};

type Evidence = {
  event?: {
    sequence: number;
    type: "workspace_state" | "file_change";
    path?: string;
    origin?: string;
    changes?: { rangeOffset: number; rangeLength: number; text: string }[];
  };
};

const labels = {
  large_paste: "Large Paste",
  unattributed_bulk_change: "Unattributed Bulk Change",
  work_history_gap: "Work History Gap",
};

export default function IntegritySignalReview({
  signals,
  inspect,
  review,
}: {
  signals: IntegritySignal[];
  inspect: (signalId: string) => Promise<Evidence>;
  review: (signalId: string, state: "reviewed" | "dismissed", note?: string) => Promise<void>;
}) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState<Record<string, Evidence>>({});
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  async function inspectSignal(signalId: string) {
    setBusy(signalId);
    setError(undefined);
    try {
      const result = await inspect(signalId);
      setEvidence((current) => ({ ...current, [signalId]: result }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not inspect evidence");
    } finally {
      setBusy(undefined);
    }
  }

  async function finish(signalId: string, state: "reviewed" | "dismissed") {
    setBusy(signalId);
    setError(undefined);
    try {
      await review(signalId, state, notes[signalId]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update review");
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="flex flex-col gap-4 border-t border-foreground/10 pt-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">Integrity Signals</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Specific Work History evidence for Teacher review. Signals do not determine intent,
          misconduct, a Grade, or a Student risk score.
        </p>
      </div>
      {signals.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Integrity Signals for this Work History.</p>
      ) : (
        <ul role="list" className="divide-y divide-foreground/10 border-y border-foreground/10">
          {signals.map((signal) => {
            const inspected = evidence[signal._id];
            return (
              <li className="grid gap-3 py-5" key={signal._id}>
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div>
                    <h3 className="font-medium">{labels[signal.type]}</h3>
                    <p className="text-sm text-muted-foreground">
                      {signal.eventSequence !== undefined
                        ? `Event ${signal.eventSequence} · ${signal.path}`
                        : `Sequence ${signal.sequenceStart}–${signal.sequenceEnd} · ${signal.gapReason}`}
                    </p>
                  </div>
                  <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {signal.state}
                  </p>
                </div>
                {signal.eventSequence !== undefined ? (
                  <p className="text-sm tabular-nums text-muted-foreground">
                    {signal.insertedCharacters} inserted · {signal.deletedCharacters} removed ·{" "}
                    {Math.round((signal.contribution ?? 0) * 100)}% of resulting file
                  </p>
                ) : null}
                {inspected?.event ? (
                  <div className="border-l-2 border-foreground/20 pl-3 text-sm">
                    <p>
                      Event {inspected.event.sequence}: {inspected.event.path} · Edit Origin{" "}
                      {inspected.event.origin}
                    </p>
                    <p className="text-muted-foreground">
                      {inspected.event.changes?.length ?? 0} exact model change
                      {(inspected.event.changes?.length ?? 0) === 1 ? "" : "s"}
                    </p>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy === signal._id}
                    onClick={() => void inspectSignal(signal._id)}
                  >
                    Inspect evidence
                  </Button>
                </div>
                {signal.state === "open" ? (
                  <div className="grid max-w-2xl gap-2">
                    <label className="grid gap-1 text-sm">
                      Optional Teacher note
                      <Textarea
                        value={notes[signal._id] ?? ""}
                        maxLength={2_000}
                        onChange={(event) =>
                          setNotes((current) => ({
                            ...current,
                            [signal._id]: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy === signal._id}
                        onClick={() => void finish(signal._id, "reviewed")}
                      >
                        Mark reviewed
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy === signal._id}
                        onClick={() => void finish(signal._id, "dismissed")}
                      >
                        Dismiss
                      </Button>
                    </div>
                  </div>
                ) : signal.teacherNote ? (
                  <p className="text-sm text-muted-foreground">
                    Teacher note: {signal.teacherNote}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}
