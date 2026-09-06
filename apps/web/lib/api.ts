"use client";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const TOKEN_KEY = "referly.token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(token: string | null) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; json?: unknown; token?: string | null } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = init.token === undefined ? getToken() : init.token;
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${API_URL}${path}`, { method: init.method ?? "GET", headers, body: init.json !== undefined ? JSON.stringify(init.json) : undefined, credentials: "include" });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = body?.error ?? {};
    if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/v1/auth")) {
      setToken(null);
      const target = window.location.pathname.startsWith("/portal") ? "/login?portal=1" : "/login";
      if (!window.location.pathname.startsWith("/login")) window.location.href = target;
    }
    throw new ApiError(res.status, err.code ?? "http", describe(err) || `request failed (${res.status})`, err.details);
  }
  return body as T;
}

function describe(err: { message?: string; details?: { issues?: { path: (string | number)[]; message: string }[] } }): string {
  const issues = err.details?.issues;
  if (issues?.length) return issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
  return err.message ?? "";
}
