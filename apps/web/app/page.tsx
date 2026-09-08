"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { signedInHint } from "@/lib/api";

export default function Index() {
  const router = useRouter();
  useEffect(() => {
    router.replace(signedInHint() ? "/app" : "/login");
  }, [router]);
  return null;
}
