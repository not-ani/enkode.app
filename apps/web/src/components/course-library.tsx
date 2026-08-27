import { api } from "@/lib/convex-api";
import { Button } from "@enkode.app/ui/components/button";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { messageFrom } from "@/lib/error-message";

export default function CourseLibrary({ courseId }: { courseId: string }) {
  const items = useQuery(api.courses.library, { courseId });
  const moveLibraryItem = useMutation(api.courses.moveLibraryItem);
  const [error, setError] = useState<string>();

  async function move(itemId: string, direction: "up" | "down") {
    setError(undefined);
    try {
      await moveLibraryItem({ courseId, itemId, direction });
    } catch (caught) {
      setError(messageFrom(caught, "Could not reorder the Course library"));
    }
  }

  return (
    <section className="border-t border-foreground/10 pt-4">
      <h4 className="text-sm font-medium">Ordered Course library</h4>
      {!items ? (
        <p className="mt-2 text-sm text-muted-foreground">Loading Course library…</p>
      ) : items.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Assignments and Materials appear here as you create them.
        </p>
      ) : (
        <ol className="mt-2 divide-y divide-foreground/10">
          {items.map((item, index) => (
            <li className="flex items-center justify-between gap-3 py-2" key={item.id}>
              <p className="min-w-0 truncate text-sm">
                {index + 1}. {item.title}{" "}
                <span className="text-muted-foreground">· {item.kind}</span>
              </p>
              <div className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={index === 0}
                  onClick={() => void move(item.id, "up")}
                >
                  Up
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={index === items.length - 1}
                  onClick={() => void move(item.id, "down")}
                >
                  Down
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
    </section>
  );
}
