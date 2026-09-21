import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it, expect, vi, beforeEach } from "vitest";

// The SDK is mocked ahead of the import under test, so every request shape
// the store builds is recorded rather than sent.
const mockSend = vi.fn();
const uploads: { params: Record<string, unknown>; body: Buffer }[] = [];

vi.mock("@aws-sdk/client-s3", () => {
  class MockS3Client {
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
    }
    send = mockSend;
  }
  const command = (name: string) =>
    class {
      readonly commandName = name;
      constructor(input: Record<string, unknown>) {
        Object.assign(this, input);
      }
    };
  return {
    S3Client: MockS3Client,
    PutObjectCommand: command("PutObject"),
    GetObjectCommand: command("GetObject"),
    HeadObjectCommand: command("HeadObject"),
    DeleteObjectCommand: command("DeleteObject"),
  };
});

vi.mock("@aws-sdk/lib-storage", () => {
  class MockUpload {
    private readonly params: { Body: Readable } & Record<string, unknown>;
    constructor(options: {
      params: { Body: Readable } & Record<string, unknown>;
    }) {
      this.params = options.params;
    }
    async done(): Promise<void> {
      const chunks: Buffer[] = [];
      for await (const chunk of this.params.Body) {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
      uploads.push({ params: this.params, body: Buffer.concat(chunks) });
    }
  }
  return { Upload: MockUpload };
});

const signed = vi.fn();
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: (
    _client: unknown,
    command: Record<string, unknown>,
    options: { expiresIn: number },
  ) => {
    signed(command, options);
    return Promise.resolve(
      `https://test-bucket.example/${String(command.Key)}?X-Amz-Expires=${String(options.expiresIn)}`,
    );
  },
}));

import { S3BlobStore } from "./blob-s3.js";
import type { S3BlobConfig } from "./blob-s3.js";
import { BlobHashMismatch } from "./blob-store.js";

const defaultConfig: S3BlobConfig = {
  bucket: "test-bucket",
  region: "us-east-1",
};

function notFound(name: "NoSuchKey" | "NotFound"): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

function hashOf(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** A store whose marker the mocked bucket already holds. */
async function attached(config = defaultConfig): Promise<S3BlobStore> {
  const store = new S3BlobStore(config);
  mockSend.mockResolvedValueOnce({
    Body: { transformToString: () => Promise.resolve('{"id":"store-1"}') },
  });
  await store.attach();
  return store;
}

describe("S3BlobStore", () => {
  beforeEach(() => {
    mockSend.mockReset();
    signed.mockReset();
    uploads.length = 0;
  });

  describe("constructor", () => {
    it("refuses a missing bucket or region", () => {
      expect(() => new S3BlobStore(defaultConfig)).not.toThrow();
      expect(
        () => new S3BlobStore({ bucket: "", region: "us-east-1" }),
      ).toThrow("S3_BUCKET is required");
      expect(() => new S3BlobStore({ bucket: "b", region: "" })).toThrow(
        "S3_REGION is required",
      );
    });

    it("names the store by bucket and prefix, never by a credential", () => {
      const store = new S3BlobStore({
        ...defaultConfig,
        accessKeyId: "AKIA-not-in-the-locator",
        secretAccessKey: "secret",
      });
      expect(store.locator).toBe("s3://test-bucket/blobs");
      expect(store.kind).toBe("s3");
    });

    it("sets path style only when an endpoint is given", () => {
      const aws = new S3BlobStore(defaultConfig) as unknown as {
        client: { config: Record<string, unknown> };
      };
      expect(aws.client.config).not.toHaveProperty("forcePathStyle");
      const custom = new S3BlobStore({
        ...defaultConfig,
        endpoint: "http://127.0.0.1:3900",
      }) as unknown as { client: { config: Record<string, unknown> } };
      expect(custom.client.config.forcePathStyle).toBe(true);
      const hosted = new S3BlobStore({
        ...defaultConfig,
        endpoint: "https://storage.example",
        forcePathStyle: false,
      }) as unknown as { client: { config: Record<string, unknown> } };
      expect(hosted.client.config.forcePathStyle).toBe(false);
    });
  });

  describe("attach", () => {
    it("reads the id from the marker the bucket holds", async () => {
      const store = await attached();
      expect(store.id).toBe("store-1");
      const [command] = mockSend.mock.calls[0] as [Record<string, unknown>];
      expect(command.Key).toBe("blobs/.marfa-store");
    });

    it("mints an id and writes the marker when the bucket has none", async () => {
      const store = new S3BlobStore(defaultConfig);
      mockSend.mockRejectedValueOnce(notFound("NoSuchKey"));
      mockSend.mockResolvedValueOnce({});
      await store.attach();
      expect(store.id).toMatch(/^[0-9a-f-]{36}$/);
      const [put] = mockSend.mock.calls[1] as [Record<string, unknown>];
      expect(put.commandName).toBe("PutObject");
      expect(put.Key).toBe("blobs/.marfa-store");
      expect(JSON.parse(String(put.Body))).toEqual({ id: store.id });
    });

    it("refuses to answer an id before attach", async () => {
      const store = new S3BlobStore(defaultConfig);
      expect(() => store.id).toThrow(/attach/);
      mockSend.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve('{"id":"store-1"}') },
      });
      await store.attach();
      expect(store.id).toBe("store-1");
    });
  });

  describe("put", () => {
    it("uploads a verified stream under the prefixed key", async () => {
      const store = await attached();
      const bytes = Buffer.from("hello object store");
      mockSend.mockRejectedValueOnce(notFound("NotFound"));
      await store.put(hashOf(bytes), {
        stream: Readable.from(bytes),
        size_bytes: bytes.length,
      });
      expect(uploads).toHaveLength(1);
      expect(uploads[0]?.params.Bucket).toBe("test-bucket");
      expect(uploads[0]?.params.Key).toBe(
        `blobs/${hashOf(bytes).slice("sha256:".length)}`,
      );
      expect(uploads[0]?.body.equals(bytes)).toBe(true);
      // The attach and the presence check; nothing else was sent.
      expect(mockSend).toHaveBeenCalledTimes(2);
      const [head] = mockSend.mock.calls[1] as [Record<string, unknown>];
      expect(head.commandName).toBe("HeadObject");
    });

    it("refuses a mismatched stream before a byte is uploaded", async () => {
      const store = await attached();
      const bytes = Buffer.from("these bytes");
      const wrongName = hashOf(Buffer.from("other bytes"));
      mockSend.mockRejectedValueOnce(notFound("NotFound"));
      await expect(
        store.put(wrongName, {
          stream: Readable.from(bytes),
          size_bytes: bytes.length,
        }),
      ).rejects.toBeInstanceOf(BlobHashMismatch);
      expect(uploads).toHaveLength(0);
      // No object was written, so there is nothing to take down: the
      // presence check is the last request the store sent.
      expect(mockSend).toHaveBeenCalledTimes(2);

      // The witness: the same bytes under their own name go up.
      mockSend.mockRejectedValueOnce(notFound("NotFound"));
      await store.put(hashOf(bytes), {
        stream: Readable.from(bytes),
        size_bytes: bytes.length,
      });
      expect(uploads).toHaveLength(1);
    });

    it("uploads a path source as it is", async () => {
      const store = await attached();
      const bytes = Buffer.from("bytes the caller hashed");
      const dir = await mkdtemp(join(tmpdir(), "blob-s3-test-"));
      const path = join(dir, "spool");
      await writeFile(path, bytes);
      mockSend.mockRejectedValueOnce(notFound("NotFound"));
      await store.put(hashOf(bytes), { path, size_bytes: bytes.length });
      expect(uploads).toHaveLength(1);
      expect(uploads[0]?.body.equals(bytes)).toBe(true);
      await rm(dir, { recursive: true, force: true });
    });

    it("leaves an object the bucket already holds alone", async () => {
      const store = await attached();
      const bytes = Buffer.from("already there");
      mockSend.mockResolvedValueOnce({ ContentLength: bytes.length });
      await store.put(hashOf(bytes), {
        stream: Readable.from(bytes),
        size_bytes: bytes.length,
      });
      expect(uploads).toHaveLength(0);
    });

    it("replaces an object of the wrong size", async () => {
      const store = await attached();
      const bytes = Buffer.from("the right bytes");
      mockSend.mockResolvedValueOnce({ ContentLength: bytes.length + 7 });
      await store.put(hashOf(bytes), {
        stream: Readable.from(bytes),
        size_bytes: bytes.length,
      });
      expect(uploads).toHaveLength(1);
      expect(uploads[0]?.body.equals(bytes)).toBe(true);
    });

    it("honors a custom prefix", async () => {
      const store = await attached({ ...defaultConfig, prefix: "drill/one" });
      const bytes = Buffer.from("prefixed");
      mockSend.mockRejectedValueOnce(notFound("NotFound"));
      await store.put(hashOf(bytes), {
        stream: Readable.from(bytes),
        size_bytes: bytes.length,
      });
      expect(uploads[0]?.params.Key).toBe(
        `drill/one/${hashOf(bytes).slice("sha256:".length)}`,
      );
    });
  });

  describe("has", () => {
    it("answers the size of a present object", async () => {
      const store = await attached();
      mockSend.mockResolvedValueOnce({ ContentLength: 42 });
      expect(await store.has("sha256:abc")).toEqual({ size_bytes: 42 });
      const [head] = mockSend.mock.calls[1] as [Record<string, unknown>];
      expect(head.commandName).toBe("HeadObject");
      expect(head.Key).toBe("blobs/abc");
    });

    it("answers null for an absent object under either name the store uses", async () => {
      const store = await attached();
      mockSend.mockResolvedValueOnce({ ContentLength: 42 });
      expect(await store.has("sha256:abc")).not.toBeNull();
      mockSend.mockRejectedValueOnce(notFound("NotFound"));
      expect(await store.has("sha256:abc")).toBeNull();
      mockSend.mockRejectedValueOnce(notFound("NoSuchKey"));
      expect(await store.has("sha256:abc")).toBeNull();
    });

    it("rethrows anything else", async () => {
      const store = await attached();
      mockSend.mockRejectedValueOnce(new Error("AccessDenied"));
      await expect(store.has("sha256:abc")).rejects.toThrow("AccessDenied");
    });
  });

  describe("get", () => {
    it("streams the whole object", async () => {
      const store = await attached();
      mockSend.mockResolvedValueOnce({
        Body: Readable.from(Buffer.from("payload")),
        ContentLength: 7,
      });
      const read = await store.get("sha256:abc");
      expect(read).not.toBeNull();
      expect(read?.size_bytes).toBe(7);
      expect(read?.offset).toBe(0);
      expect(read?.length).toBe(7);
    });

    it("asks for a range and reads the total from Content-Range", async () => {
      const store = await attached();
      mockSend.mockResolvedValueOnce({
        Body: Readable.from(Buffer.from("ayl")),
        ContentLength: 3,
        ContentRange: "bytes 1-3/7",
      });
      const read = await store.get("sha256:abc", { start: 1, end: 3 });
      const [get] = mockSend.mock.calls[1] as [Record<string, unknown>];
      expect(get.Range).toBe("bytes=1-3");
      expect(read?.size_bytes).toBe(7);
      expect(read?.offset).toBe(1);
      expect(read?.length).toBe(3);
    });

    it("answers null for an absent object", async () => {
      const store = await attached();
      mockSend.mockResolvedValueOnce({
        Body: Readable.from(Buffer.from("payload")),
        ContentLength: 7,
      });
      expect(await store.get("sha256:abc")).not.toBeNull();
      mockSend.mockRejectedValueOnce(notFound("NoSuchKey"));
      expect(await store.get("sha256:abc")).toBeNull();
    });
  });

  describe("delete", () => {
    it("sends a delete for the prefixed key", async () => {
      const store = await attached();
      mockSend.mockResolvedValueOnce({});
      await store.delete("sha256:abc");
      const [del] = mockSend.mock.calls[1] as [Record<string, unknown>];
      expect(del.commandName).toBe("DeleteObject");
      expect(del.Key).toBe("blobs/abc");
    });
  });

  describe("link", () => {
    it("signs a GET for the object with the lifetime asked for", async () => {
      const store = await attached();
      const url = await store.link("sha256:abc", 900);
      expect(url).toBe(
        "https://test-bucket.example/blobs/abc?X-Amz-Expires=900",
      );
      const [command, options] = signed.mock.calls[0] as [
        Record<string, unknown>,
        { expiresIn: number },
      ];
      expect(command.commandName).toBe("GetObject");
      expect(options.expiresIn).toBe(900);
    });
  });
});
