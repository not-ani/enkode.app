import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

const convexUrlSchema = (exampleHost: string) =>
  z.url().refine((url) => new URL(url).hostname !== exampleHost, {
    message: `Replace the ${exampleHost} placeholder before running the app`,
  });

const webSocketUrlSchema = z.url().refine(
  (url) => {
    const protocol = new URL(url).protocol;
    return protocol === "ws:" || protocol === "wss:";
  },
  { message: "Use a ws:// or wss:// Enkode Python language-service endpoint" },
);

export const env = createEnv({
  clientPrefix: "VITE_",
  client: {
    VITE_CONVEX_URL: convexUrlSchema("example.convex.cloud"),
    VITE_CONVEX_SITE_URL: convexUrlSchema("example.convex.site"),
    VITE_PYRIGHT_LANGUAGE_SERVICE_URL: webSocketUrlSchema.optional(),
  },
  runtimeEnv: (import.meta as any).env,
  emptyStringAsUndefined: true,
});
