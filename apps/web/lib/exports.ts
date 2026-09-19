"use client";

import { API_URL } from "./api";

/**
 * Exports are prepared in the background, so the person who asked for one may be on another page
 * by the time it is ready. The ids they asked for in this browser tab are kept in sessionStorage;
 * the watcher in the app shell follows them and announces each one when it finishes.
 */
export const EXPORT_REQUESTED = "referly:export-requested";
export const EXPORT_FINISHED = "referly:export-finished";
const KEY = "referly.exports.watching";

export interface ExportFile {
  id: string;
  entity: string;
  label: string;
  fileName: string;
  status: "queued" | "running" | "done" | "failed";
  rowCount: number | null;
  error: string | null;
}

export function watchedExports(): string[] {
  try {
    const ids = JSON.parse(window.sessionStorage.getItem(KEY) || "[]");
    return Array.isArray(ids) ? ids.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function save(ids: string[]) {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(ids.slice(-20)));
  } catch {
    /* storage unavailable: the page that asked still follows its own export */
  }
}

/** Follow an export until it finishes, wherever the person goes in the app meanwhile. */
export function watchExport(id: string) {
  save([...new Set([...watchedExports(), id])]);
  window.dispatchEvent(new CustomEvent(EXPORT_REQUESTED, { detail: id }));
}

export function unwatchExport(id: string) {
  save(watchedExports().filter((x) => x !== id));
}

/** Fetch the finished file with the session cookie and hand it to the browser under its own name. */
export async function downloadExport(file: Pick<ExportFile, "id" | "fileName">): Promise<boolean> {
  const res = await fetch(`${API_URL}/v1/analytics/exports/${file.id}/download`, { credentials: "include" });
  if (!res.ok) return false;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = file.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}
