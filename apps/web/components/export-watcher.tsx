"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { EXPORT_FINISHED, EXPORT_REQUESTED, downloadExport, unwatchExport, watchedExports, type ExportFile } from "@/lib/exports";
import { showToast } from "./toast";

const POLL_MS = 3000;
const ANALYTICS = "/app/analytics";

/**
 * Follows the exports this person asked for until each one finishes, on whatever page they are
 * by then, and says so: a toast with the download right in it. The Analytics page listens for
 * the same moment to bring its file list into view.
 */
export function ExportWatcher() {
  const pathname = usePathname();
  const onAnalytics = useRef(false);
  onAnalytics.current = pathname === ANALYTICS;
  const [watching, setWatching] = useState(0);

  useEffect(() => {
    const sync = () => setWatching(watchedExports().length);
    sync();
    window.addEventListener(EXPORT_REQUESTED, sync);
    return () => window.removeEventListener(EXPORT_REQUESTED, sync);
  }, []);

  useEffect(() => {
    if (!watching) return;
    let stopped = false;
    const tick = async () => {
      for (const id of watchedExports()) {
        try {
          const { export: file } = await api<{ export: ExportFile }>(`/v1/analytics/exports/${id}`);
          if (stopped) return;
          if (file.status !== "done" && file.status !== "failed") continue;
          unwatchExport(id);
          announce(file, onAnalytics.current);
        } catch (err) {
          // Gone, or not this person's any more: stop asking. Anything else is a blip; try again next round.
          if (err instanceof ApiError && (err.status === 404 || err.status === 403)) unwatchExport(id);
        }
      }
      if (!stopped) setWatching(watchedExports().length);
    };
    const timer = setInterval(tick, POLL_MS);
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [watching]);

  return null;
}

function announce(file: ExportFile, onAnalytics: boolean) {
  window.dispatchEvent(new CustomEvent<ExportFile>(EXPORT_FINISHED, { detail: file }));
  if (file.status === "failed") {
    showToast({
      kind: "error",
      title: `${file.label} could not be prepared`,
      body: file.error ?? "Something went wrong while building the file.",
      actions: onAnalytics ? [] : [{ label: "Try again", href: `${ANALYTICS}#exports`, primary: true }],
    });
    return;
  }
  const rows = file.rowCount ?? 0;
  showToast({
    kind: "success",
    title: `${file.label} is ready`,
    body: `${rows.toLocaleString()} ${rows === 1 ? "row" : "rows"} · ${file.fileName}`,
    actions: [
      {
        label: "Download",
        primary: true,
        onClick: () => {
          void downloadExport(file).then((ok) => {
            if (!ok) showToast({ kind: "error", title: "The file could not be downloaded", body: "Try again from Analytics, under Export data.", actions: [{ label: "Open", href: `${ANALYTICS}#exports` }] });
          });
        },
      },
      ...(onAnalytics ? [] : [{ label: "Show my files", href: `${ANALYTICS}#exports` }]),
    ],
  });
}
