import { invalidTransition } from "./errors";

export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export function canTransition<S extends string>(table: TransitionTable<S>, from: S, to: S): boolean {
  return table[from]?.includes(to) ?? false;
}

export function assertTransition<S extends string>(entity: string, table: TransitionTable<S>, from: S, to: S): void {
  if (!canTransition(table, from, to)) throw invalidTransition(entity, from, to);
}

export type OfferStatus = "draft" | "active" | "paused" | "archived";
export const OFFER_TRANSITIONS: TransitionTable<OfferStatus> = {
  draft: ["active", "archived"],
  active: ["paused", "archived"],
  paused: ["active", "archived"],
  archived: [],
};

export type ProgramStatus = OfferStatus;
export const PROGRAM_TRANSITIONS = OFFER_TRANSITIONS;

export type AffiliateStatus = "applied" | "active" | "suspended" | "rejected";
export const AFFILIATE_TRANSITIONS: TransitionTable<AffiliateStatus> = {
  applied: ["active", "rejected"],
  active: ["suspended"],
  suspended: ["active"],
  rejected: ["active"],
};

export type ConversionStatus = "pending" | "approved" | "refunded" | "cancelled" | "reversed" | "disputed";
export const CONVERSION_TRANSITIONS: TransitionTable<ConversionStatus> = {
  pending: ["approved", "refunded", "cancelled", "reversed", "disputed"],
  approved: ["refunded", "reversed", "disputed"],
  disputed: ["pending", "approved", "refunded", "cancelled", "reversed"], // pending: restored after a rejected/withdrawn dispute
  refunded: ["refunded", "reversed"], // further partial refunds stay in refunded
  cancelled: [],
  reversed: [],
};

export type CommissionStatus = "pending" | "approved" | "payable" | "paid" | "reversed" | "void";
export const COMMISSION_TRANSITIONS: TransitionTable<CommissionStatus> = {
  pending: ["approved", "payable", "reversed", "void"],
  approved: ["payable", "reversed", "void"],
  payable: ["paid", "reversed"],
  paid: [], // money already moved: corrections happen through ledger clawbacks, never status changes
  reversed: [],
  void: [],
};

export type PayoutStatus = "draft" | "processing" | "paid" | "failed" | "cancelled";
export const PAYOUT_TRANSITIONS: TransitionTable<PayoutStatus> = {
  draft: ["processing", "paid", "cancelled"],
  processing: ["paid", "failed"],
  failed: ["processing", "cancelled"],
  paid: [],
  cancelled: [],
};

export type JobStatus = "queued" | "running" | "done" | "failed" | "dead";
