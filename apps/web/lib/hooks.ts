"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import { showToast } from "@/components/toast";

export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    api<T>(path)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);

  return { data, error, loading, reload };
}

const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Wraps a mutation with a busy flag and says how it went. Inside the app the answer is a toast,
 * because the button that was pressed is often far down a long table and a banner at the top of
 * the page goes unseen; `error` and `success` stay null then. With `inline` (a form that shows
 * its own message right beside the button), or on pages outside the app shell where nothing can
 * show a toast, the message is returned as state for the caller to render.
 */
export function useAction(opts: { inline?: boolean } = {}) {
  const inline = !!opts.inline;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, okMessage?: string): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      setSuccess(null);
      try {
        const out = await fn();
        if (okMessage && (inline || !showToast({ kind: "success", title: okMessage }))) setSuccess(okMessage);
        return out;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (inline || !showToast({ kind: "error", title: sentence(message) })) setError(message);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [inline],
  );
  return { busy, error, success, run, setError, setSuccess };
}
