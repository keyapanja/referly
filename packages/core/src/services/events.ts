import type { DbLike } from "../db/client";
import type { TenantContext } from "../context";
import { enqueueJob } from "./jobs";

/**
 * Domain events are written to the job table in the same transaction as the change that
 * produced them (transactional outbox). Workers for notifications and automation rules
 * consume them, so every automated action traces back to a stored event.
 */
export type DomainEventType =
  | "affiliate.applied"
  | "affiliate.approved"
  | "affiliate.rejected"
  | "affiliate.suspended"
  | "affiliate.reactivated"
  | "affiliate.invited"
  | "affiliate.joined_program"
  | "click.recorded"
  | "conversion.created"
  | "conversion.refunded"
  | "conversion.cancelled"
  | "conversion.reattributed"
  | "commission.created"
  | "commission.approved"
  | "commission.payable"
  | "commission.reversed"
  | "commission.adjusted"
  | "payout.created"
  | "payout.paid"
  | "payout.failed"
  | "program.activated"
  | "program.updated"
  | "campaign.started"
  | "campaign.ended";

export interface DomainEvent {
  type: DomainEventType;
  tenantId: string;
  occurredAt: string;
  actor: { type: string; id?: string };
  entityType: string;
  entityId: string;
  data: Record<string, unknown>;
}

export async function emitEvent(
  db: DbLike,
  ctx: TenantContext,
  type: DomainEventType,
  entity: { type: string; id: string },
  data: Record<string, unknown> = {},
): Promise<DomainEvent> {
  const event: DomainEvent = {
    type,
    tenantId: ctx.tenantId,
    occurredAt: ctx.now().toISOString(),
    actor: { type: ctx.actor.type, id: ctx.actor.id },
    entityType: entity.type,
    entityId: entity.id,
    data,
  };
  await enqueueJob(db, {
    tenantId: ctx.tenantId,
    type: "domain_event",
    payload: event as unknown as Record<string, unknown>,
    runAt: ctx.now(),
  });
  return event;
}
