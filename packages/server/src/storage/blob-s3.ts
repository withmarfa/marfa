import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { BlobBackend } from "./blob-backend.js";

export interface S3BlobConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  prefix?: string;
  /**
   * Path-style addressing (`<endpoint>/<bucket>/<key>`) rather than
   * virtual-hosted (`<bucket>.<endpoint>/<key>`). Only consulted when an
   * endpoint is set; AWS itself is always virtual-hosted.
   *
   * Defaults to true, because MinIO needs it and the self-host quickstart
   * is the deployment most likely to be wrong about this. Stores that
   * present virtual-hosted URLs set it false.
   *
   * It matters for presigned URLs as much as for direct calls, since both
   * are signed by the same client and the style is part of the signature.
   */
  forcePathStyle?: boolean;
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
        ? {
            endpoint: config.endpoint,
            forcePathStyle: config.forcePathStyle ?? true,
          }
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
    // Strip algorithm prefix (sha256:) — S3 keys are the raw hex hash
    const bare = key.replace(/^sha256:/, "");
    return `${this.prefix}/${bare}`;
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

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.prefixedKey(key),
      }),
    );
  }

  async *list(): AsyncIterable<string> {
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: `${this.prefix}/`,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of response.Contents ?? []) {
        if (!obj.Key) continue;
        // Strip prefix ("blobs/") to get raw hex, re-add sha256: to match DB format
        const hex = obj.Key.slice(this.prefix.length + 1);
        if (hex) yield `sha256:${hex}`;
      }
      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined;
    } while (continuationToken);
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
