"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

export interface StatusOption {
  value: string;
  /** What the status means, in the merchant's words. */
  label: string;
}

/**
 * A list's status filter. The choice lives in the address (`?status=`), so it can be linked to
 * and survives a reload, but changing it swaps the address in place: the page is not reloaded and
 * the rest of it stays as it was.
 */
export function StatusFilter({ options, allLabel = "All statuses", param = "status", label = "Filter by status" }: { options: StatusOption[]; allLabel?: string; param?: string; label?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const value = params.get(param) ?? "";
  return (
    <select
      value={value}
      aria-label={label}
      onChange={(e) => {
        const next = new URLSearchParams(params.toString());
        if (e.target.value) next.set(param, e.target.value);
        else next.delete(param);
        const query = next.toString();
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
      }}
    >
      <option value="">{allLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** The statuses of each list, said the way a merchant would. Each starts with the word the badge in the table shows. */
export const STATUS_OPTIONS = {
  affiliates: [
    { value: "applied", label: "Applied · waiting for your approval" },
    { value: "active", label: "Active" },
    { value: "suspended", label: "Suspended" },
    { value: "rejected", label: "Rejected" },
  ],
  conversions: [
    { value: "pending", label: "Pending · inside the holding period" },
    { value: "approved", label: "Approved · holding period over" },
    { value: "refunded", label: "Refunded" },
    { value: "cancelled", label: "Cancelled" },
    { value: "reversed", label: "Reversed" },
    { value: "disputed", label: "Disputed · on hold" },
  ],
  commissions: [
    { value: "pending", label: "Pending · inside the holding period" },
    { value: "approved", label: "Approved · still inside the holding period" },
    { value: "payable", label: "Payable · ready to go into a payout" },
    { value: "paid", label: "Paid" },
    { value: "reversed", label: "Reversed · taken back after a refund" },
    { value: "void", label: "Void · cancelled before it was earned" },
  ],
  payouts: [
    { value: "draft", label: "Draft · not sent yet" },
    { value: "processing", label: "Processing · being paid" },
    { value: "paid", label: "Paid" },
    { value: "failed", label: "Failed" },
    { value: "cancelled", label: "Cancelled" },
  ],
} satisfies Record<string, StatusOption[]>;
