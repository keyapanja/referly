import { readFileSync } from "node:fs";
import { zipFiles } from "./zip";

/**
 * The Referly plugin for WordPress (TRK-09). One install and one pasted connection key replace
 * the manual setup: the plugin prints the tracking code on every page and reports paid
 * WooCommerce orders from the server, refunds included. The PHP lives beside this file and is
 * served as an installable zip, so the plugin always matches the API that hands it out.
 */
const SOURCE = new URL("./wordpress/", import.meta.url);
/** Fixed timestamp inside the archive, so the same plugin version is the same bytes. */
const ARCHIVE_DATE = new Date(Date.UTC(2026, 8, 11));

export const WORDPRESS_PLUGIN_PATH = "/wordpress/referly.zip";

let cached: { zip: Buffer; version: string } | null = null;

export function wordpressPlugin(): { zip: Buffer; version: string } {
  if (cached) return cached;
  const php = readFileSync(new URL("referly.php", SOURCE));
  const readme = readFileSync(new URL("readme.txt", SOURCE));
  const version = /^\s*\*\s*Version:\s*([0-9][0-9.]*)/m.exec(php.toString("utf8"))?.[1] ?? "0";
  const zip = zipFiles(
    [
      { name: "referly/" },
      { name: "referly/referly.php", data: php },
      { name: "referly/readme.txt", data: readme },
    ],
    ARCHIVE_DATE,
  );
  cached = { zip, version };
  return cached;
}

/**
 * What the merchant pastes into the plugin: the API address and a key that can only report
 * conversions, in one string. `rfly1_` versions the format; the rest is base64url JSON.
 */
export function connectionKey(apiBase: string, secret: string): string {
  return `rfly1_${Buffer.from(JSON.stringify({ api: apiBase.replace(/\/$/, ""), key: secret })).toString("base64url")}`;
}

export function parseConnectionKey(value: string): { api: string; key: string } | null {
  const m = /^rfly1_([A-Za-z0-9_-]+)$/.exec(value.trim());
  if (!m) return null;
  try {
    const data = JSON.parse(Buffer.from(m[1]!, "base64url").toString("utf8")) as { api?: unknown; key?: unknown };
    return typeof data.api === "string" && typeof data.key === "string" ? { api: data.api, key: data.key } : null;
  } catch {
    return null;
  }
}
