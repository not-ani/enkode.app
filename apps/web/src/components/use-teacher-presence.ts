import { api } from "@/lib/convex-api";
import { useMutation } from "convex/react";
import { useEffect, useState } from "react";

import { messageFrom } from "@/lib/error-message";

const HEARTBEAT_INTERVAL_MS = 20_000;

export function useTeacherPresence(
  workspaceId: string,
  viewKind: "workspace" | "work_history",
  enabled = true,
) {
  const enter = useMutation(api.liveWorkspaces.enter);
  const heartbeat = useMutation(api.liveWorkspaces.heartbeat);
  const leave = useMutation(api.liveWorkspaces.leave);
  const [sessionId, setSessionId] = useState<string>();
  const [entered, setEntered] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => setSessionId(crypto.randomUUID()), [workspaceId]);

  useEffect(() => {
    if (!sessionId || !enabled) return;
    let active = true;
    let heartbeatTimer: number | undefined;
    void enter({ workspaceId, sessionId, viewKind })
      .then(() => {
        if (!active) {
          void leave({ workspaceId, sessionId });
          return;
        }
        setEntered(true);
        heartbeatTimer = window.setInterval(() => {
          void heartbeat({ workspaceId, sessionId, viewKind }).catch(() => {
            if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
            setEntered(false);
          });
        }, HEARTBEAT_INTERVAL_MS);
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(messageFrom(caught, "Could not record Teacher presence"));
        }
      });

    return () => {
      active = false;
      if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer);
      void leave({ workspaceId, sessionId });
    };
  }, [enabled, enter, heartbeat, leave, sessionId, viewKind, workspaceId]);

  return { entered, error, sessionId };
}
