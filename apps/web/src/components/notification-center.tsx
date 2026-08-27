import { api } from "@/lib/convex-api";
import { Bell } from "lucide-react";
import { useMutation, useQuery } from "convex/react";

type Notification = {
  _id: string;
  type:
    | "assignment_available"
    | "assignment_changed"
    | "material_available"
    | "material_changed"
    | "grade_returned"
    | "submission_needs_review";
  title: string;
  body: string;
  href: string;
  createdAt: number;
  readAt?: number;
};

export default function NotificationCenter() {
  const notifications = useQuery(api.notifications.listMine);
  const markRead = useMutation(api.notifications.markRead);
  const unreadCount = notifications?.filter(({ readAt }) => readAt === undefined).length ?? 0;

  async function open(notification: Notification) {
    if (notification.readAt === undefined) {
      await markRead({ notificationId: notification._id });
    }
    window.location.assign(notification.href);
  }

  return (
    <details className="group relative">
      <summary className="relative flex min-h-10 cursor-pointer list-none items-center gap-2 px-2 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:min-h-8">
        <Bell aria-hidden="true" className="size-4" strokeWidth={1.75} />
        <span className="sr-only">Notifications</span>
        {unreadCount > 0 ? (
          <span
            className="bg-foreground text-background flex size-5 items-center justify-center rounded-full text-[0.6875rem] font-medium tabular-nums"
            aria-label={`${unreadCount} unread Notifications`}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </summary>
      <section className="bg-background absolute right-0 z-50 mt-2 w-[min(24rem,calc(100vw-1rem))] border border-foreground/15 shadow-lg">
        <header className="flex items-baseline justify-between gap-3 border-b border-foreground/10 px-4 py-3">
          <h2 className="font-medium">Notifications</h2>
          <span className="text-muted-foreground text-xs tabular-nums">
            {unreadCount === 0 ? "Up to date" : `${unreadCount} unread`}
          </span>
        </header>
        {!notifications ? (
          <p className="text-muted-foreground px-4 py-5 text-sm">Loading…</p>
        ) : notifications.length === 0 ? (
          <p className="text-muted-foreground px-4 py-5 text-sm">Nothing needs your attention.</p>
        ) : (
          <ul className="max-h-[min(30rem,70vh)] overflow-y-auto" role="list">
            {notifications.map((notification) => (
              <li className="border-b border-foreground/10 last:border-b-0" key={notification._id}>
                <button
                  className="hover:bg-muted focus-visible:bg-muted flex w-full items-start gap-3 px-4 py-3 text-left focus-visible:outline-none"
                  type="button"
                  onClick={() => void open(notification)}
                >
                  <span
                    className={`mt-1.5 size-2 shrink-0 rounded-full ${notification.readAt === undefined ? "bg-blue-600" : "bg-transparent"}`}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{notification.title}</span>
                    <span className="text-muted-foreground mt-0.5 block text-sm">
                      {notification.body}
                    </span>
                    <span className="text-muted-foreground mt-1 block text-xs">
                      {new Date(notification.createdAt).toLocaleString()}
                    </span>
                  </span>
                  <span className="sr-only">
                    {notification.readAt === undefined ? "Unread" : "Read"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </details>
  );
}
