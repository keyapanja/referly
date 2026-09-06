import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "../db/client";
import { authTokens, sessions, tenants, users, type User } from "../db/schema";
import { newId, newSecret } from "../ids";
import { notFound, validation } from "../errors";
import { systemContext, type TenantContext } from "../context";
import { hashPassword, sha256 } from "./auth";
import { writeAudit } from "./audit";
import { emitEvent } from "./events";

/**
 * Email verification and password reset (PRD s9.1 step 1, s13). Tokens are single-use,
 * stored hashed, and scoped to a purpose. Emails go out through the event pipeline so the
 * worker and message log handle delivery like every other notification.
 */

export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;

type Purpose = "verify_email" | "reset_password";

async function issueToken(db: DbLike, ctx: TenantContext, userId: string, purpose: Purpose, ttlMs: number): Promise<string> {
  const token = newSecret();
  await db.insert(authTokens).values({
    id: newId("authToken"),
    tenantId: ctx.tenantId,
    userId,
    purpose,
    tokenHash: sha256(token),
    expiresAt: new Date(ctx.now().getTime() + ttlMs),
    createdAt: ctx.now(),
  });
  return token;
}

async function consumeToken(db: DbLike, token: string, purpose: Purpose, now: Date): Promise<User> {
  const row = await db.query.authTokens.findFirst({
    where: and(eq(authTokens.tokenHash, sha256(token)), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now)),
  });
  if (!row) throw validation("this link is invalid or has expired");
  await db.update(authTokens).set({ usedAt: now }).where(eq(authTokens.id, row.id));
  const user = await db.query.users.findFirst({ where: eq(users.id, row.userId) });
  if (!user) throw notFound("user");
  return user;
}

/** Called on signup and from "resend". Emits `user.verify_email` carrying the token. */
export async function requestEmailVerification(db: DbLike, ctx: TenantContext, user: User): Promise<void> {
  if (user.emailVerifiedAt) return;
  const token = await issueToken(db, ctx, user.id, "verify_email", VERIFY_TTL_MS);
  await emitEvent(db, ctx, "user.verify_email", { type: "user", id: user.id }, { email: user.email, name: user.name, token });
}

export async function verifyEmail(db: DbLike, token: string, now = new Date()): Promise<User> {
  const user = await consumeToken(db, token, "verify_email", now);
  const [after] = await db.update(users).set({ emailVerifiedAt: user.emailVerifiedAt ?? now, updatedAt: now }).where(eq(users.id, user.id)).returning();
  const ctx = systemContext(user.tenantId, () => now);
  await writeAudit(db, ctx, { entityType: "user", entityId: user.id, action: "email_verified" });
  await emitEvent(db, ctx, "user.email_verified", { type: "user", id: user.id }, { email: user.email });
  return after!;
}

export const forgotPasswordSchema = z.object({ email: z.string().email(), tenantSlug: z.string().optional() });

/**
 * Always resolves without revealing whether the email exists. A person can belong to several
 * workspaces; each active match gets its own email naming the workspace.
 */
export async function requestPasswordReset(db: DbLike, rawInput: z.input<typeof forgotPasswordSchema>, now = new Date()): Promise<number> {
  const input = forgotPasswordSchema.parse(rawInput);
  const email = input.email.trim().toLowerCase();
  const rows = await db
    .select({ user: users, tenant: tenants })
    .from(users)
    .innerJoin(tenants, eq(users.tenantId, tenants.id))
    .where(and(eq(users.email, email), eq(users.status, "active"), input.tenantSlug ? eq(tenants.slug, input.tenantSlug) : undefined));
  for (const { user } of rows) {
    const ctx = systemContext(user.tenantId, () => now);
    const token = await issueToken(db, ctx, user.id, "reset_password", RESET_TTL_MS);
    await emitEvent(db, ctx, "user.password_reset_requested", { type: "user", id: user.id }, { email: user.email, name: user.name, token });
  }
  return rows.length;
}

export const resetPasswordSchema = z.object({ token: z.string().min(10), password: z.string().min(8) });

export async function resetPassword(db: DbLike, rawInput: z.input<typeof resetPasswordSchema>, now = new Date()): Promise<User> {
  const input = resetPasswordSchema.parse(rawInput);
  const user = await consumeToken(db, input.token, "reset_password", now);
  const passwordHash = await hashPassword(input.password);
  const [after] = await db
    .update(users)
    .set({ passwordHash, emailVerifiedAt: user.emailVerifiedAt ?? now, updatedAt: now })
    .where(eq(users.id, user.id))
    .returning();
  // Invalidate other outstanding reset links and every existing session.
  await db.update(authTokens).set({ usedAt: now }).where(and(eq(authTokens.userId, user.id), eq(authTokens.purpose, "reset_password"), isNull(authTokens.usedAt)));
  await db.delete(sessions).where(eq(sessions.userId, user.id));
  await writeAudit(db, systemContext(user.tenantId, () => now), { entityType: "user", entityId: user.id, action: "password_reset" });
  return after!;
}
