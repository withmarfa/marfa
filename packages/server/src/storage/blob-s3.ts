import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
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
  spoolVerified,
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
      // The store's own checksums are the hash in every object's name: a
      // stream is hashed before it is uploaded and hashed again by whoever
      // reads it back. The SDK's CRC checksums are left to a caller that
      // asks for them, because a multipart object read back from an
      // S3-compatible store can carry a checksum header the SDK's default
      // validation does not expect, and a read of every large blob fails
      // on a check that proves nothing the hash does not.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
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
    // Content addressing: an object already under this name holds these
    // bytes, and uploading over it could only replace them with themselves.
    const present = await this.has(hash);
    if (present !== null && present.size_bytes === source.size_bytes) return;
    // An object store cannot rename, so nothing is uploaded under a name it
    // might not deserve: a stream is spooled and verified before a byte
    // leaves the process, and a path is a file its caller has just hashed,
    // as it is on disk.
    if ("path" in source) {
      await this.upload(hash, source.path);
      return;
    }
    const spool = await mkdtemp(join(tmpdir(), "marfa-blob-"));
    try {
      const path = join(spool, "spool");
      await spoolVerified(path, hash, source);
      await this.upload(hash, path);
    } finally {
      await rm(spool, { recursive: true, force: true });
    }
  }

  private async upload(hash: string, path: string): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: this.key(hash),
        Body: createReadStream(path),
        CacheControl: "public, max-age=31536000, immutable",
      },
    });
    await upload.done();
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
