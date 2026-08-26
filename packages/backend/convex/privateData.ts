import { query } from "./_generated/server";
import { requireAuthenticatedUser } from "./authorization";

export const get = query({
  args: {},
  handler: async (ctx) => {
    await requireAuthenticatedUser(ctx);
    return {
      message: "This is private",
    };
  },
});
