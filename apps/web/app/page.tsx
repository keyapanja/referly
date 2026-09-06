"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getToken } from "@/lib/api";

export default function Index() {
  const router = useRouter();
  useEffect(() => {
    router.replace(getToken() ? "/app" : "/login");
  }, [router]);
  return null;
}
