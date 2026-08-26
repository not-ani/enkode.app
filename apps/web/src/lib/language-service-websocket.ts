import type {
  LanguageServiceConnection,
  LanguageServiceTransport,
} from "./python-language-service";

type JsonMessage =
  | { id: number; result?: unknown; error?: { message?: string } }
  | { method: string; params?: unknown };

export class WebSocketLanguageServiceTransport implements LanguageServiceTransport {
  async connect(endpoint: string) {
    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error("Could not connect to Python intelligence")),
        {
          once: true,
        },
      );
    });
    return createConnection(socket);
  }
}

function createConnection(socket: WebSocket): LanguageServiceConnection {
  let nextId = 1;
  let disposed = false;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  const notificationListeners = new Set<(method: string, params: unknown) => void>();
  const closeListeners = new Set<(reason?: string) => void>();

  socket.addEventListener("message", (event) => {
    let message: JsonMessage;
    try {
      message = JSON.parse(String(event.data)) as JsonMessage;
    } catch {
      return;
    }
    if ("id" in message) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error)
        request.reject(new Error(message.error.message ?? "Language request failed"));
      else request.resolve(message.result);
      return;
    }
    for (const listener of notificationListeners) listener(message.method, message.params);
  });

  socket.addEventListener("close", (event) => {
    if (disposed) return;
    const reason = event.reason || "Python intelligence disconnected";
    for (const request of pending.values()) request.reject(new Error(reason));
    pending.clear();
    for (const listener of closeListeners) listener(reason);
  });

  return {
    request<Result>(method: string, params: unknown) {
      if (socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error("Python intelligence disconnected"));
      }
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise<Result>((resolve, reject) => {
        pending.set(id, {
          resolve: (value) => resolve(value as Result),
          reject,
        });
      });
    },
    async notify(method, params) {
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("Python intelligence disconnected");
      }
      socket.send(JSON.stringify({ method, params }));
    },
    onNotification(listener) {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    dispose() {
      disposed = true;
      for (const request of pending.values())
        request.reject(new Error("Language request canceled"));
      pending.clear();
      socket.close();
    },
  };
}
