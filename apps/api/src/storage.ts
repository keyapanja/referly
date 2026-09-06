import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * File storage for uploaded assets (AST-01). Two backends:
 *  - local: files under FILES_DIR, served by the API at BASE_URL/files/<key>. Good for dev,
 *    single-VM self-hosting, and docker compose (mount a volume).
 *  - s3: any S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces).
 *    Objects are written with public-read and addressed via S3_PUBLIC_URL (a CDN or the
 *    bucket's public origin).
 * Keys are tenant-scoped and unguessable: tenants/<tenantId>/assets/<random>.<ext>.
 */
export interface StoredFile {
  key: string;
  url: string;
  contentType: string;
  sizeBytes: number;
}

export interface PutOptions {
  /** Not publicly readable; only reachable through an authenticated API endpoint. */
  private?: boolean;
}

export interface FileStorage {
  put(key: string, data: Uint8Array, contentType: string, opts?: PutOptions): Promise<StoredFile>;
  get(key: string): Promise<{ data: Uint8Array; contentType: string } | null>;
}

/** Keys under this prefix are never served by the public /files route. */
export const PRIVATE_PREFIX = "private/";

export const ALLOWED_UPLOAD_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "video/webm": "webm",
};
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export function createFileStorage(env: NodeJS.ProcessEnv = process.env, baseUrl = env.BASE_URL ?? "http://localhost:4000"): FileStorage {
  const kind = (env.STORAGE_PROVIDER ?? "local").toLowerCase();
  if (kind === "s3") {
    for (const k of ["S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) if (!env[k]) throw new Error(`${k} is required when STORAGE_PROVIDER=s3`);
    return new S3Storage({
      bucket: env.S3_BUCKET!,
      region: env.S3_REGION!,
      endpoint: env.S3_ENDPOINT,
      accessKeyId: env.S3_ACCESS_KEY_ID!,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      publicUrl: env.S3_PUBLIC_URL ?? (env.S3_ENDPOINT ? `${env.S3_ENDPOINT.replace(/\/$/, "")}/${env.S3_BUCKET}` : `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com`),
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
    });
  }
  if (kind === "local") return new LocalStorage(env.FILES_DIR ?? path.resolve("data/files"), baseUrl);
  throw new Error(`unknown STORAGE_PROVIDER ${kind}`);
}

export class LocalStorage implements FileStorage {
  constructor(
    readonly dir: string,
    private readonly baseUrl: string,
  ) {}

  private resolve(key: string): string {
    const full = path.resolve(this.dir, key);
    if (!full.startsWith(path.resolve(this.dir) + path.sep)) throw new Error("invalid key");
    return full;
  }

  async put(key: string, data: Uint8Array, contentType: string, _opts?: PutOptions): Promise<StoredFile> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
    await writeFile(`${full}.meta`, JSON.stringify({ contentType }));
    return { key, url: `${this.baseUrl.replace(/\/$/, "")}/files/${key}`, contentType, sizeBytes: data.byteLength };
  }

  async get(key: string) {
    let full: string;
    try {
      full = this.resolve(key);
    } catch {
      return null;
    }
    try {
      const [data, meta] = await Promise.all([readFile(full), readFile(`${full}.meta`, "utf8").catch(() => "{}")]);
      const contentType = (JSON.parse(meta) as { contentType?: string }).contentType ?? "application/octet-stream";
      return { data, contentType };
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }
}

export class S3Storage implements FileStorage {
  private client: Promise<import("@aws-sdk/client-s3").S3Client> | null = null;
  constructor(private readonly opts: { bucket: string; region: string; endpoint?: string; accessKeyId: string; secretAccessKey: string; publicUrl: string; forcePathStyle: boolean }) {}

  private async s3() {
    if (!this.client) {
      this.client = import("@aws-sdk/client-s3").then(
        (m) => new m.S3Client({ region: this.opts.region, endpoint: this.opts.endpoint, forcePathStyle: this.opts.forcePathStyle, credentials: { accessKeyId: this.opts.accessKeyId, secretAccessKey: this.opts.secretAccessKey } }),
      );
    }
    return this.client;
  }

  async put(key: string, data: Uint8Array, contentType: string, opts?: PutOptions): Promise<StoredFile> {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.s3();
    const isPrivate = opts?.private ?? key.startsWith(PRIVATE_PREFIX);
    await client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        ...(isPrivate ? {} : { ACL: "public-read", CacheControl: "public, max-age=31536000, immutable" }),
      }),
    );
    return { key, url: isPrivate ? "" : `${this.opts.publicUrl.replace(/\/$/, "")}/${key}`, contentType, sizeBytes: data.byteLength };
  }

  async get(key: string) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.s3();
    try {
      const res = await client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      const data = await res.Body!.transformToByteArray();
      return { data, contentType: res.ContentType ?? "application/octet-stream" };
    } catch (err) {
      if ((err as { name?: string }).name === "NoSuchKey") return null;
      throw err;
    }
  }
}

/** Deterministic, unguessable object key for a tenant upload. */
export function assetKey(tenantId: string, contentType: string, data: Uint8Array): string {
  const ext = ALLOWED_UPLOAD_TYPES[contentType] ?? "bin";
  const digest = createHash("sha256").update(data).digest("hex").slice(0, 24);
  return `tenants/${tenantId}/assets/${digest}.${ext}`;
}
