import { and, eq, gt, isNull, ne } from "drizzle-orm";
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import type { DbLike } from "../db/client";
import { apiKeys, sessions, tenants, users, type User } from "../db/schema";
import { newId, newSecret } from "../ids";
import { unauthenticated, validation } from "../errors";
import type { Role, TenantContext } from "../context";
import * as ctxMod from "../context";

const scrypt = (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))));

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/** OWASP guidance: scrypt N=2^17, r=8, p=1. Hashes record their cost so it can be raised later. */
const SCRYPT_N = 131072;
const SCRYPT_OPTS = { N: SCRYPT_N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const LEGACY_N = 16384;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw validation("password must be at least 8 characters");
  if (password.length > 256) throw validation("password is too long");
  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, 64, SCRYPT_OPTS)) as Buffer;
  return `scrypt$${SCRYPT_N}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** A stored hash to compare against when the account does not exist, so a miss costs the same as a wrong password. */
let dummyHash: Promise<string> | null = null;
function dummy(): Promise<string> {
  return (dummyHash ??= hashPassword(randomBytes(24).toString("base64")));
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    await verifyPassword(password, await dummy());
    return false;
  }
  if (password.length > 256) return false;
  const parts = stored.split("$");
  let n = LEGACY_N;
  let saltB64: string | undefined;
  let keyB64: string | undefined;
  if (parts.length === 4) [, , saltB64, keyB64] = parts, (n = Number(parts[1]));
  else [, saltB64, keyB64] = parts;
  if (parts[0] !== "scrypt" || !saltB64 || !keyB64 || !Number.isInteger(n) || n < 1024) return false;
  const key = (await scrypt(password, Buffer.from(saltB64, "base64"), 64, { ...SCRYPT_OPTS, N: n })) as Buffer;
  const expected = Buffer.from(keyB64, "base64");
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** True when the stored hash was made with a lower cost than today's setting. */
export function passwordNeedsRehash(stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  return parts.length !== 4 || Number(parts[1]) < SCRYPT_N;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface AuthenticatedUser {
  user: User;
  tenantId: string;
  role: Role;
}

export async function loginWithPassword(db: DbLike, input: { tenantSlug?: string; email: string; password: string }, now = new Date()) {
  const email = input.email.trim().toLowerCase();
  // A person may exist in several tenants; when no slug is given, pick the first active membership.
  const rows = await db
    .select({ user: users, tenant: tenants })
    .from(users)
    .innerJoin(tenants, eq(users.tenantId, tenants.id))
    .where(and(eq(users.email, email), eq(users.status, "active"), eq(tenants.status, "active"), input.tenantSlug ? eq(tenants.slug, input.tenantSlug) : undefined));
  for (const row of rows) {
    if (await verifyPassword(input.password, row.user.passwordHash)) {
      const session = await createSession(db, row.user, now);
      // Transparent upgrade of hashes made with an older cost.
      const rehash = passwordNeedsRehash(row.user.passwordHash) ? await hashPassword(input.password) : null;
      await db.update(users).set({ lastLoginAt: now, ...(rehash ? { passwordHash: rehash } : {}) }).where(eq(users.id, row.user.id));
      return { ...session, user: row.user, tenant: row.tenant };
    }
  }
  // Unknown email: burn the same time as a real comparison so the response does not reveal it.
  if (!rows.length) await verifyPassword(input.password, null);
  throw unauthenticated("invalid email or password");
}

export async function createSession(db: DbLike, user: User, now = new Date()) {
  const token = newSecret();
  await db.insert(sessions).values({
    id: newId("session"),
    tenantId: user.tenantId,
    userId: user.id,
    tokenHash: sha256(token),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    createdAt: now,
  });
  return { token, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) };
}

export async function resolveSession(db: DbLike, token: string, now = new Date()): Promise<AuthenticatedUser | null> {
  const row = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, now), eq(users.status, "active")))
    .limit(1);
  const user = row[0]?.user;
  if (!user) return null;
  return { user, tenantId: user.tenantId, role: user.role as Role };
}

export async function resolveUserById(db: DbLike, userId: string): Promise<User | null> {
  return (await db.query.users.findFirst({ where: eq(users.id, userId) })) ?? null;
}

export async function revokeSession(db: DbLike, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
}

// ---------------------------------------------------------------------------
// API keys (used by integrations to post conversions)
// ---------------------------------------------------------------------------

export const DEFAULT_API_KEY_SCOPES = ["conversions.write", "read"];

export async function createApiKey(db: DbLike, ctx: TenantContext, input: { name: string; scopes?: string[] }) {
  ctxMod.require(ctx, "integrations.manage");
  const scopes = [...new Set(input.scopes?.length ? input.scopes : DEFAULT_API_KEY_SCOPES)];
  const bad = scopes.filter((s) => !(ctxMod.API_KEY_SCOPES as string[]).includes(s));
  if (bad.length) throw validation(`unknown or disallowed API key scopes: ${bad.join(", ")}`, { allowed: ctxMod.API_KEY_SCOPES });
  const secret = `rk_live_${newSecret()}`;
  const [row] = await db
    .insert(apiKeys)
    .values({
      id: newId("apiKey"),
      tenantId: ctx.tenantId,
      name: input.name,
      keyHash: sha256(secret),
      prefix: secret.slice(0, 12),
      scopes,
      createdByUserId: ctx.actor.type === "user" ? (ctx.actor.id ?? null) : null,
      createdAt: ctx.now(),
    })
    .returning();
  return { apiKey: row!, secret };
}

export async function resolveApiKey(db: DbLike, secret: string, now = new Date()) {
  const row = await db.query.apiKeys.findFirst({ where: and(eq(apiKeys.keyHash, sha256(secret)), isNull(apiKeys.revokedAt)) });
  if (!row) return null;
  await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.id));
  return row;
}

export async function revokeApiKey(db: DbLike, ctx: TenantContext, apiKeyId: string): Promise<void> {
  ctxMod.require(ctx, "integrations.manage");
  await db
    .update(apiKeys)
    .set({ revokedAt: ctx.now() })
    .where(and(eq(apiKeys.id, apiKeyId), eq(apiKeys.tenantId, ctx.tenantId)));
}

/** Authenticated password change: verifies the current password and signs out every other session. */
export async function changePassword(db: DbLike, userId: string, input: { currentPassword: string; newPassword: string; keepSessionToken?: string }, now = new Date()): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || !(await verifyPassword(input.currentPassword, user.passwordHash))) throw unauthenticated("current password is incorrect");
  if (input.newPassword === input.currentPassword) throw validation("choose a different password");
  const passwordHash = await hashPassword(input.newPassword);
  await db.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, userId));
  const keep = input.keepSessionToken ? sha256(input.keepSessionToken) : null;
  await db.delete(sessions).where(keep ? and(eq(sessions.userId, userId), ne(sessions.tokenHash, keep)) : eq(sessions.userId, userId));
}
