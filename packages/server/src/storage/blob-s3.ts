import { createReadStream } from "node:fs";
import { pipeline, Readable } from "node:stream";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { generateId } from "@withmarfa/shared";
import {
  bareHex,
  BlobHashMismatch,
  HashingTransform,
  type BlobRead,
  type BlobSource,
  type BlobStore,
  type ByteRange,
} from "./blob-store.js";

export interface S3BlobConfig {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Key prefix inside the bucket. The database's replica lives beside it
   *  under its own prefix, so one bucket carries one instance. */
  prefix?: string;
  /**
   * Path-style addressing (`<endpoint>/<bucket>/<key>`) rather than
   * virtual-hosted (`<bucket>.<endpoint>/<key>`). Only consulted when an
   * endpoint is set; AWS itself is always virtual-hosted. The style is part
   * of a presigned link's signature, so it matters for links as much as
   * for direct calls.
   */
  forcePathStyle?: boolean;
}

const MARKER = ".marfa-store";

/**
 * Bytes in an S3-compatible bucket, one object per hash under the prefix,
 * beside a marker object naming the store. The client's own SigV4 signing
 * is what makes the link a store-signed one: a client fetches from the
 * bucket, and the instance is not in the path.
 */
export class S3BlobStore implements BlobStore {
  readonly kind = "s3" as const;
  readonly locator: string;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly client: S3Client;
  private storeId: string | null = null;

  constructor(config: S3BlobConfig) {
    if (!config.bucket)
      throw new Error("S3_BUCKET is required for an S3 store");
    if (!config.region)
      throw new Error("S3_REGION is required for an S3 store");
    this.bucket = config.bucket;
    this.prefix = config.prefix ?? "blobs";
    this.locator = `s3://${this.bucket}/${this.prefix}`;
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

  get id(): string {
    if (this.storeId === null) {
      throw new Error("S3BlobStore: attach() before reading the id");
    }
    return this.storeId;
  }

  private key(hash: string): string {
    return `${this.prefix}/${bareHex(hash)}`;
  }

  async attach(): Promise<void> {
    const markerKey = `${this.prefix}/${MARKER}`;
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: markerKey }),
      );
      const parsed = JSON.parse(
        (await response.Body?.transformToString()) ?? "",
      ) as { id?: unknown };
      if (typeof parsed.id !== "string" || parsed.id.length === 0) {
        throw new Error(`the store marker at ${this.locator} names no id`);
      }
      this.storeId = parsed.id;
      return;
    } catch (err) {
      if (!isNoSuchKey(err)) throw err;
    }
    const id = generateId();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: markerKey,
        Body: JSON.stringify({ id }) + "\n",
        ContentType: "application/json",
      }),
    );
    this.storeId = id;
  }

  async put(hash: string, source: BlobSource): Promise<void> {
    const body =
      "path" in source ? createReadStream(source.path) : source.stream;
    // Hashed on the way up whichever shape the source took: an object store
    // cannot rename, so a mismatch is found after the bytes landed and the
    // object is taken down again.
    const hashing = new HashingTransform();
    // `pipeline`, not `pipe`: a source that fails must destroy the transform
    // the upload is reading, or the upload waits for bytes that never come.
    pipeline(body, hashing, () => undefined);
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: this.key(hash),
        Body: hashing,
        CacheControl: "public, max-age=31536000, immutable",
      },
    });
    await upload.done();
    const actual = hashing.digest();
    if (actual !== hash || hashing.bytes !== source.size_bytes) {
      await this.delete(hash);
      throw new BlobHashMismatch(hash, actual);
    }
  }

  async get(hash: string, range?: ByteRange): Promise<BlobRead | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.key(hash),
          ...(range
            ? { Range: `bytes=${String(range.start)}-${String(range.end)}` }
            : {}),
        }),
      );
      if (!response.Body) return null;
      const size = range
        ? (totalFromContentRange(response.ContentRange) ??
          response.ContentLength ??
          0)
        : (response.ContentLength ?? 0);
      const offset = range?.start ?? 0;
      const length = response.ContentLength ?? size - offset;
      return {
        stream: response.Body as Readable,
        size_bytes: size,
        offset,
        length,
      };
    } catch (err) {
      if (isNoSuchKey(err)) return null;
      throw err;
    }
  }

  async has(hash: string): Promise<{ size_bytes: number } | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(hash) }),
      );
      return { size_bytes: response.ContentLength ?? 0 };
    } catch (err) {
      if (isNoSuchKey(err)) return null;
      throw err;
    }
  }

  async delete(hash: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(hash) }),
    );
  }

  async link(hash: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: this.key(hash) }),
      { expiresIn: ttlSeconds },
    );
  }
}

/** `bytes 10-19/27000` → 27000. */
function totalFromContentRange(header: string | undefined): number | null {
  if (!header) return null;
  const match = /\/(\d+)$/.exec(header);
  return match ? Number(match[1]) : null;
}

/** An absent object, whichever of its two names the store answers with. */
function isNoSuchKey(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "NoSuchKey" || err.name === "NotFound")
  );
}
