import { api } from "@/lib/convex-api";
import { useQuery } from "convex/react";

function words(value: string) {
  return value.replaceAll("_", " ").replaceAll(".", " · ");
}

function timestamp(value: number) {
  return `${new Date(value).toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

export default function AuditEventExplorer() {
  const events = useQuery(api.audit.listMine, { limit: 100 });

  return (
    <section className="border-y border-foreground/10 py-6" aria-labelledby="audit-events-title">
      <div className="flex flex-col gap-1">
        <h2 id="audit-events-title" className="text-lg font-medium">
          Audit Events
        </h2>
        <p className="text-muted-foreground max-w-[65ch] text-pretty text-sm">
          Administrative and academic actions for the Courses and Classrooms you manage. Audit
          Events are separate from Student Work History.
        </p>
      </div>

      {!events ? (
        <p className="text-muted-foreground mt-4 text-sm">Loading Audit Events…</p>
      ) : events.length === 0 ? (
        <p className="text-muted-foreground mt-4 text-sm">
          No Audit Events are available for your teaching assignments.
        </p>
      ) : (
        <ol className="mt-4 divide-y divide-foreground/10 border-y border-foreground/10">
          {events.map((event) => (
            <li
              className="grid gap-1 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-6"
              key={event.id}
            >
              <p className="min-w-0 text-sm font-medium capitalize">{words(event.action)}</p>
              <time
                className="text-muted-foreground text-xs tabular-nums sm:text-right"
                dateTime={new Date(event.occurredAt).toISOString()}
              >
                {timestamp(event.occurredAt)}
              </time>
              <p className="text-muted-foreground min-w-0 text-xs sm:col-span-2">
                {event.actor.kind === "developer"
                  ? "Developer"
                  : `${event.actor.displayName}${event.actor.username ? ` (@${event.actor.username})` : ""}`}
                {" · "}
                <span className="capitalize">{words(event.resource.kind)}</span>{" "}
                <code className="break-all">{event.resource.id}</code>
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
