import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Secret storage for integration credentials (PRD s13 "secure secret management"). AES-256-GCM
 * with a key derived from INTEGRATION_SECRET. Ciphertext is versioned so the scheme can rotate.
 * In development a fixed insecure key is used and a warning is printed once.
 */
let warned = false;

function key(): Buffer {
  const secret = process.env.INTEGRATION_SECRET;
  if (!secret && !warned && process.env.NODE_ENV === "production") {
    warned = true;
    console.warn("[crypto] INTEGRATION_SECRET is not set; integration credentials are encrypted with an insecure default key");
  }
  return createHash("sha256").update(secret ?? "dev-insecure-integration-secret").digest();
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${Buffer.concat([iv, tag, ciphertext]).toString("base64")}`;
}

export function decryptJson<T = unknown>(payload: string): T {
  if (!payload.startsWith("v1:")) throw new Error("unsupported ciphertext version");
  const buf = Buffer.from(payload.slice(3), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
