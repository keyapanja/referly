"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/**
 * Toasts: a short notice in the corner for something that finished while the person was looking
 * elsewhere. Any component calls `showToast`; the one `ToastHost` in the app shell renders them.
 * They go away by themselves, stay while the pointer or keyboard focus is on them, and are
 * announced to screen readers (errors assertively).
 */
export interface ToastAction {
  label: string;
  onClick?: () => void;
  href?: string;
  primary?: boolean;
}
export interface ToastInput {
  kind?: "success" | "error" | "info";
  title: string;
  body?: string;
  actions?: ToastAction[];
  /** How long it stays, in milliseconds. Errors stay longer by default. */
  durationMs?: number;
}

const EVENT = "referly:toast";
const MAX_VISIBLE = 4;
let hosts = 0;

/** Shows the toast and says whether anything could show it: pages outside the app shell (sign-in, join) have no host and keep their feedback inline. */
export function showToast(toast: ToastInput): boolean {
  if (typeof window === "undefined" || hosts === 0) return false;
  window.dispatchEvent(new CustomEvent<ToastInput>(EVENT, { detail: toast }));
  return true;
}

interface Shown extends ToastInput {
  id: number;
}

function ToastCard({ toast, onClose }: { toast: Shown; onClose: () => void }) {
  const [held, setHeld] = useState(false);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (held) return;
    const t = setTimeout(() => close.current(), toast.durationMs ?? (toast.kind === "error" ? 20_000 : 12_000));
    return () => clearTimeout(t);
  }, [held, toast.durationMs, toast.kind]);
  const kind = toast.kind ?? "info";
  return (
    <div className={`toast ${kind}`} role={kind === "error" ? "alert" : "status"} onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
      <div className="toast-text">
        <strong>{toast.title}</strong>
        {toast.body ? <span className="muted">{toast.body}</span> : null}
      </div>
      {toast.actions?.length ? (
        <div className="toast-actions">
          {toast.actions.map((a) =>
            a.href ? (
              <Link key={a.label} className={`btn sm ${a.primary ? "primary" : ""}`} href={a.href} onClick={onClose}>
                {a.label}
              </Link>
            ) : (
              <button
                key={a.label}
                type="button"
                className={`sm ${a.primary ? "primary" : ""}`}
                onClick={() => {
                  a.onClick?.();
                  onClose();
                }}
              >
                {a.label}
              </button>
            ),
          )}
        </div>
      ) : null}
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

export function ToastHost() {
  const [toasts, setToasts] = useState<Shown[]>([]);
  const next = useRef(1);
  useEffect(() => {
    hosts++;
    const on = (e: Event) => {
      const detail = (e as CustomEvent<ToastInput>).detail;
      if (!detail?.title) return;
      setToasts((list) => [...list, { ...detail, id: next.current++ }].slice(-MAX_VISIBLE));
    };
    window.addEventListener(EVENT, on);
    return () => {
      hosts--;
      window.removeEventListener(EVENT, on);
    };
  }, []);
  if (!toasts.length) return null;
  return (
    <div className="toast-host" aria-live="polite">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onClose={() => setToasts((list) => list.filter((x) => x.id !== t.id))} />
      ))}
    </div>
  );
}
