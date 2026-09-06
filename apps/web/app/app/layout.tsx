"use client";

import type { ReactNode } from "react";
import { Shell } from "@/components/shell";

export default function MerchantLayout({ children }: { children: ReactNode }) {
  return <Shell mode="merchant">{children}</Shell>;
}
