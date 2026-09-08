import { z } from "zod";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";

/** zod's `.url()` accepts any scheme (javascript:, data:, file:). Everything we render as a link or fetch must be http(s). */
export const httpUrl = z
  .string()
  .max(2048)
  .url()
  .refine((u) => /^https?:$/.test(safeProtocol(u)), "url must start with http:// or https://");

function safeProtocol(u: string): string {
  try {
    return new URL(u).protocol;
  } catch {
    return "";
  }
}

/**
 * SSRF guard for URLs the platform will fetch on a merchant's behalf (outbound webhooks).
 * Rejects loopback, private, link-local (cloud metadata), unique-local, multicast and
 * unspecified addresses, plus hostnames that only ever resolve there.
 */
export function isPublicIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false; // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false; // 192.0.0.0/24 + 192.0.2.0/24
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
    if (a === 203 && b === 0) return false;
    if (a >= 224) return false; // multicast + reserved + broadcast
    return true;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return false;
    if (lower.startsWith("::ffff:")) return isPublicIp(lower.slice(7));
    if (/^f[cd]/.test(lower)) return false; // fc00::/7 unique local
    if (/^fe[89ab]/.test(lower)) return false; // fe80::/10 link-local
    if (lower.startsWith("ff")) return false; // multicast
    if (lower.startsWith("2001:db8")) return false; // documentation
    if (lower.startsWith("64:ff9b:")) return isPublicIp(lower.split(":").slice(-1).join("")) && !lower.includes("::"); // NAT64: treat as private unless clearly mapped
    return true;
  }
  return false;
}

const BLOCKED_HOSTS = /(^|\.)(localhost|localdomain|local|internal|home\.arpa|in-addr\.arpa|ip6\.arpa)$/i;

/** Synchronous checks on the literal URL (used at save time; no network). */
export function urlLooksPublic(u: string): { ok: true } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return { ok: false, reason: "invalid url" };
  }
  if (!/^https?:$/.test(parsed.protocol)) return { ok: false, reason: "url must be http(s)" };
  if (parsed.username || parsed.password) return { ok: false, reason: "url must not contain credentials" };
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!host) return { ok: false, reason: "url has no host" };
  if (BLOCKED_HOSTS.test(host)) return { ok: false, reason: "url must be a public host" };
  if (isIP(host) && !isPublicIp(host)) return { ok: false, reason: "url must not point at a private or reserved address" };
  return { ok: true };
}

export type Lookup = (hostname: string) => Promise<{ address: string }[]>;
const defaultLookup: Lookup = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

/** Resolves the host and refuses if ANY address is non-public (a name that mixes public and private records is hostile). */
export async function assertPublicUrl(u: string, lookup: Lookup = defaultLookup): Promise<void> {
  const literal = urlLooksPublic(u);
  if (!literal.ok) throw new Error(literal.reason);
  const host = new URL(u).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return;
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host);
  } catch {
    throw new Error(`could not resolve ${host}`);
  }
  if (!addrs.length) throw new Error(`could not resolve ${host}`);
  for (const a of addrs) if (!isPublicIp(a.address)) throw new Error(`${host} resolves to a private or reserved address`);
}
