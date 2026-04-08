/* eslint-disable @typescript-eslint/no-non-null-assertion -- test assertions guard null access */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";

// Mock the AWS SDK before importing the module under test
const mockSend = vi.fn();

vi.mock("@aws-sdk/client-s3", () => {
  class MockS3Client {
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
    }
    send = mockSend;
  }
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class MockPutObjectCommand {
    constructor(input: Record<string, unknown>) {
      Object.assign(this, input);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class MockGetObjectCommand {
    constructor(input: Record<string, unknown>) {
      Object.assign(this, input);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class MockHeadObjectCommand {
    constructor(input: Record<string, unknown>) {
      Object.assign(this, input);
    }
  }
  return {
    S3Client: MockS3Client,
    PutObjectCommand: MockPutObjectCommand,
    GetObjectCommand: MockGetObjectCommand,
    HeadObjectCommand: MockHeadObjectCommand,
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi
    .fn()
    .mockResolvedValue(
      "https://test-bucket.s3.us-east-1.amazonaws.com/blobs/sha256%3Aabc?X-Amz-Signature=test",
    ),
}));

import { S3BlobBackend } from "./blob-s3.js";
import type { S3BlobConfig } from "./blob-s3.js";

const defaultConfig: S3BlobConfig = {
  bucket: "test-bucket",
  region: "us-east-1",
};

describe("S3BlobBackend", () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  describe("constructor", () => {
    it("throws if bucket is missing", () => {
      expect(
        () => new S3BlobBackend({ bucket: "", region: "us-east-1" }),
      ).toThrow("S3_BUCKET is required");
    });

    it("throws if region is missing", () => {
      expect(() => new S3BlobBackend({ bucket: "b", region: "" })).toThrow(
        "S3_REGION is required",
      );
    });

    it("creates successfully with valid config", () => {
      expect(() => new S3BlobBackend(defaultConfig)).not.toThrow();
    });
  });

  describe("put", () => {
    it("sends PutObjectCommand with correct params", async () => {
      const backend = new S3BlobBackend(defaultConfig);
      const data = Buffer.from("hello");
      mockSend.mockResolvedValueOnce({});

      await backend.put("sha256:abc123", data);

      expect(mockSend).toHaveBeenCalledOnce();
      const cmd = mockSend.mock.calls[0]![0] as Record<string, unknown>;
      expect(cmd.Bucket).toBe("test-bucket");
      expect(cmd.Key).toBe("blobs/abc123");
      expect(cmd.Body).toBe(data);
    });

    it("uses custom prefix", async () => {
      const backend = new S3BlobBackend({ ...defaultConfig, prefix: "custom" });
      mockSend.mockResolvedValueOnce({});

      await backend.put("sha256:abc", Buffer.from("x"));

      const cmd = mockSend.mock.calls[0]![0] as Record<string, unknown>;
      expect(cmd.Key).toBe("custom/abc");
    });
  });

  describe("get", () => {
    it("returns buffer on success", async () => {
      const backend = new S3BlobBackend(defaultConfig);
      const content = Buffer.from("file contents");
      mockSend.mockResolvedValueOnce({
        Body: {
          transformToByteArray: () => Promise.resolve(new Uint8Array(content)),
        },
      });

      const result = await backend.get("sha256:abc");

      expect(result).toBeInstanceOf(Buffer);
      expect(result!.toString()).toBe("file contents");
    });

    it("returns null when body is missing", async () => {
      const backend = new S3BlobBackend(defaultConfig);
      mockSend.mockResolvedValueOnce({ Body: null });

      const result = await backend.get("sha256:abc");

      expect(result).toBeNull();
    });

    it("returns null on NoSuchKey error", async () => {
      const backend = new S3BlobBackend(defaultConfig);
      const err = new Error("NoSuchKey");
      err.name = "NoSuchKey";
      mockSend.mockRejectedValueOnce(err);

      const result = await backend.get("sha256:abc");

      expect(result).toBeNull();
    });

    it("rethrows other errors", async () => {
      const backend = new S3BlobBackend(defaultConfig);
      mockSend.mockRejectedValueOnce(new Error("NetworkFailure"));

      await expect(backend.get("sha256:abc")).rejects.toThrow("NetworkFailure");
    });
  });

  describe("exists", () => {
    it("returns true when object exists", async () => {
      const backend = new S3BlobBackend(defaultConfig);
      mockSend.mockResolvedValueOnce({});

      expect(await backend.exists("sha256:abc")).toBe(true);
    });

    it("returns false on NoSuchKey", async () => {
      const backend = new S3BlobBackend(defaultConfig);
      const err = new Error("NoSuchKey");
      err.name = "NoSuchKey";
      mockSend.mockRejectedValueOnce(err);

      expect(await backend.exists("sha256:abc")).toBe(false);
    });

    it("returns false on NotFound", async () => {
      const backend = new S3BlobBackend(defaultConfig);
      const err = new Error("NotFound");
      err.name = "NotFound";
      mockSend.mockRejectedValueOnce(err);

      expect(await backend.exists("sha256:abc")).toBe(false);
    });

    it("rethrows other errors", async () => {
      const backend = new S3BlobBackend(defaultConfig);
      mockSend.mockRejectedValueOnce(new Error("Boom"));

      await expect(backend.exists("sha256:abc")).rejects.toThrow("Boom");
    });
  });

  describe("getPresignedUrl", () => {
    it("returns a presigned URL", async () => {
      const backend = new S3BlobBackend(defaultConfig);

      const url = await backend.getPresignedUrl("sha256:abc", 600);

      expect(url).toContain("https://");
      expect(url).toContain("test-bucket");
    });
  });

  describe("config options", () => {
    it("passes explicit credentials to S3Client", () => {
      const backend = new S3BlobBackend({
        ...defaultConfig,
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
      });

      // Access the mock client's stored config
      const client = (
        backend as unknown as {
          client: InstanceType<typeof S3Client> & {
            config: Record<string, unknown>;
          };
        }
      ).client;
      expect(client.config.credentials).toEqual({
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
      });
    });

    it("sets forcePathStyle when endpoint is provided", () => {
      const backend = new S3BlobBackend({
        ...defaultConfig,
        endpoint: "http://localhost:9000",
      });

      const client = (
        backend as unknown as {
          client: InstanceType<typeof S3Client> & {
            config: Record<string, unknown>;
          };
        }
      ).client;
      expect(client.config.endpoint).toBe("http://localhost:9000");
      expect(client.config.forcePathStyle).toBe(true);
    });

    it("does not set forcePathStyle without endpoint", () => {
      const backend = new S3BlobBackend(defaultConfig);

      const client = (
        backend as unknown as {
          client: InstanceType<typeof S3Client> & {
            config: Record<string, unknown>;
          };
        }
      ).client;
      expect(client.config.forcePathStyle).toBeUndefined();
    });
  });
});
