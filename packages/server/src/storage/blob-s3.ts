import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import type { BlobBackend } from "./blob-backend.js";

export interface S3BlobConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  prefix?: string;
}

/**
 * S3-compatible blob backend.
 * Supports AWS S3, Cloudflare R2, Backblaze B2, MinIO, and any S3-compatible store.
 * Credentials resolved via explicit config or the default AWS credential chain.
 */
export class S3BlobBackend implements BlobBackend {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly client: S3Client;

  constructor(config: S3BlobConfig) {
    if (!config.bucket)
      throw new Error("S3_BUCKET is required for S3 blob backend");
    if (!config.region)
      throw new Error("S3_REGION is required for S3 blob backend");
    this.bucket = config.bucket;
    this.prefix = config.prefix ?? "blobs";
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint
        ? { endpoint: config.endpoint, forcePathStyle: true }
        : {}),
      ...(config.accessKeyId && config.secretAccessKey
        ? {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }
        : {}),
    });
  }

  private prefixedKey(key: string): string {
    return `${this.prefix}/${key}`;
  }

  async put(key: string, bytes: Buffer, mimeType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.prefixedKey(key),
        Body: bytes,
        ...(mimeType && { ContentType: mimeType }),
        CacheControl: "public, max-age=31536000, immutable",
      }),
    );
  }

  get prefixPath(): string {
    return this.prefix;
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.prefixedKey(key),
        }),
      );
      if (!response.Body) return null;
      const byteArray = await response.Body.transformToByteArray();
      return Buffer.from(byteArray);
    } catch (err: unknown) {
      if (isNoSuchKey(err)) return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.prefixedKey(key),
        }),
      );
      return true;
    } catch (err: unknown) {
      if (isNoSuchKey(err) || isNotFound(err)) return false;
      throw err;
    }
  }

  async getPresignedUrl(key: string, ttlSeconds = 3600): Promise<string> {
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.prefixedKey(key),
    });
    return getSignedUrl(this.client, command, { expiresIn: ttlSeconds });
  }
}

function isNoSuchKey(err: unknown): boolean {
  return err instanceof Error && err.name === "NoSuchKey";
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.name === "NotFound";
}
