import { Input } from "@enkode.app/ui/components/input";

export type PublicationMode = "immediate" | "draft" | "scheduled";

export function publicationFromForm(mode: PublicationMode, form: FormData) {
  return mode === "scheduled"
    ? { mode, scheduledFor: new Date(String(form.get("scheduledFor"))).getTime() }
    : mode;
}

export function PublicationControl({
  mode,
  onChange,
}: {
  mode: PublicationMode;
  onChange: (mode: PublicationMode) => void;
}) {
  return (
    <>
      <label className="flex flex-col gap-1.5 text-base sm:text-sm">
        Publication
        <select
          value={mode}
          onChange={(event) => onChange(event.target.value as PublicationMode)}
          className="h-10 min-w-36 border border-input bg-background px-2.5 text-base outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 sm:h-8 sm:text-xs"
        >
          <option value="immediate">Publish now</option>
          <option value="draft">Save as draft</option>
          <option value="scheduled">Schedule</option>
        </select>
      </label>
      {mode === "scheduled" ? (
        <label className="flex max-w-xs flex-col gap-1.5 text-base sm:text-sm">
          Publish date and time
          <Input name="scheduledFor" type="datetime-local" required />
          <span className="text-xs text-muted-foreground">
            Uses your device timezone:{" "}
            <span suppressHydrationWarning>{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
          </span>
        </label>
      ) : null}
    </>
  );
}
