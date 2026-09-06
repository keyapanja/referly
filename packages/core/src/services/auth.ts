import { and, eq, gt, isNull } from "drizzle-orm";
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { DbLike } from "../db/client";
import { apiKeys, sessions, tenants, users, type User } from "../db/schema";
import { newId, newSecret } from "../ids";
import { unauthenticated, validation } from "../errors";
import type { Role, TenantContext } from "../context";
import * as ctxMod from "../context";

const scrypt = promisify(scryptCb);

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw validation("password must be at least 8 characters");
  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [alg, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false;
  const key = (await scrypt(password, Buffer.from(saltB64, "base64"), 64)) as Buffer;
  const expected = Buffer.from(keyB64, "base64");
  return key.length === expected.length && timingSafeEqual(key, expected);
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
    .where(and(eq(users.email, email), eq(users.status, "active"), input.tenantSlug ? eq(tenants.slug, input.tenantSlug) : undefined));
  for (const row of rows) {
    if (await verifyPassword(input.password, row.user.passwordHash)) {
      const session = await createSession(db, row.user, now);
      await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, row.user.id));
      return { ...session, user: row.user, tenant: row.tenant };
    }
  }
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

export async function createApiKey(db: DbLike, ctx: TenantContext, input: { name: string; scopes?: string[] }) {
  ctxMod.require(ctx, "integrations.manage");
  const secret = `rk_live_${newSecret()}`;
  const [row] = await db
    .insert(apiKeys)
    .values({
      id: newId("apiKey"),
      tenantId: ctx.tenantId,
      name: input.name,
      keyHash: sha256(secret),
      prefix: secret.slice(0, 12),
      scopes: input.scopes ?? ["conversions.write", "read"],
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
