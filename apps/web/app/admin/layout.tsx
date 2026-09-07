import type { ReactNode } from "react";
import { Shell } from "@/components/shell";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <Shell mode="platform">{children}</Shell>;
}
