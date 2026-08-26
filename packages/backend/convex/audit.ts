import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

type AuditEvent = {
  organizationId: Id<"organizations">;
  actor: { kind: "developer" } | { kind: "user"; userId: Id<"users"> };
  action: string;
  target: { kind: string; id: string };
};

export async function appendAuditEvent(ctx: MutationCtx, event: AuditEvent) {
  return await ctx.db.insert("auditEvents", {
    organizationId: event.organizationId,
    actorKind: event.actor.kind,
    actorUserId: event.actor.kind === "user" ? event.actor.userId : undefined,
    action: event.action,
    targetKind: event.target.kind,
    targetId: event.target.id,
    occurredAt: Date.now(),
  });
}
