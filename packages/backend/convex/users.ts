import { query } from "./_generated/server";
import { requireAuthenticatedUser } from "./authorization";

export const current = query({
  args: {},
  handler: async (ctx) => {
    const { organization, user } = await requireAuthenticatedUser(ctx);
    return {
      id: user._id,
      displayName: user.displayName,
      username: user.username,
      email: user.email,
      role: user.role,
      organization: {
        id: organization._id,
        name: organization.name,
        slug: organization.slug,
      },
    };
  },
});
