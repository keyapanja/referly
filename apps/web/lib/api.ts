"use client";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * The browser authenticates with the httpOnly session cookie the API sets on login (same-site:
 * app.example.com → api.example.com). No session token is ever kept in script-readable storage,
 * so an XSS cannot exfiltrate a reusable credential. `signedIn` is only a UX hint for redirects.
 */
const SIGNED_IN_KEY = "referly.signedIn";
const LEGACY_TOKEN_KEY = "referly.token";

export function signedInHint(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIGNED_IN_KEY) === "1";
  } catch {
    return false;
  }
}
export function setSignedInHint(on: boolean) {
  try {
    window.localStorage.removeItem(LEGACY_TOKEN_KEY);
    if (on) window.localStorage.setItem(SIGNED_IN_KEY, "1");
    else window.localStorage.removeItem(SIGNED_IN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export class ApiError extends Error {
  status: number;
  code: string;
  details: unknown;
  /** Echoed by the API on every response; quote it to support. */
  requestId: string | null;
  constructor(status: number, code: string, message: string, details?: unknown, requestId: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; json?: unknown; token?: string | null } = {}): Promise<T> {
  const headers: Record<string, string> = {};
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
      setSignedInHint(false);
      const target = window.location.pathname.startsWith("/portal") ? "/login?portal=1" : "/login";
      if (!window.location.pathname.startsWith("/login")) window.location.href = target;
    }
    const requestId = body?.requestId ?? res.headers.get("x-request-id");
    const message = describe(err) || `request failed (${res.status})`;
    throw new ApiError(res.status, err.code ?? "http", res.status >= 500 && requestId ? `${message} (reference ${requestId})` : message, err.details, requestId);
  }
  return body as T;
}

/** Multipart upload; returns the stored file descriptor from the API. */
export async function upload<T = any>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch(`${API_URL}${path}`, { method: "POST", body: form, credentials: "include" });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = body?.error ?? {};
    throw new ApiError(res.status, err.code ?? "http", describe(err) || `upload failed (${res.status})`, err.details);
  }
  return body as T;
}

function describe(err: { message?: string; details?: { issues?: { path: (string | number)[]; message: string }[] } }): string {
  const issues = err.details?.issues;
  if (issues?.length) return issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
  return err.message ?? "";
}
