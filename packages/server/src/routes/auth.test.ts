import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";

let ctx: TestContext;

beforeAll(() => {
  ctx = createTestContext();
});

afterAll(() => {
  ctx.cleanup();
});

describe("authentication", () => {
  it("returns 401 when no auth header is provided", async () => {
    const res = await request(ctx.app, "GET", "/items");
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid key", async () => {
    const res = await request(ctx.app, "GET", "/items", {
      key: "myme_k1_invalid_key",
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 with valid admin key", async () => {
    const res = await request(ctx.app, "GET", "/items", {
      key: ctx.adminKey,
    });
    expect(res.status).toBe(200);
  });
});

describe("bootstrap mode", () => {
  it("allows key creation without auth when no keys exist", async () => {
    // Create a fresh context with no keys
    const freshTmpDir = require("node:fs").mkdtempSync(
      require("node:path").join(require("node:os").tmpdir(), "myme-boot-"),
    );
    const { createSqliteStorage } = await import(
      "../storage/sqlite/index.js"
    );
    const { FilesystemBlobBackend } = await import(
      "../storage/blob-backend.js"
    );
    const { createApp } = await import("../app.js");
    const { hashApiKey } = await import("../middleware/auth.js");

    const storage = createSqliteStorage(
      require("node:path").join(freshTmpDir, "boot.db"),
    );
    const blobBackend = new FilesystemBlobBackend(
      require("node:path").join(freshTmpDir, "blobs"),
    );
    const app = createApp(storage, blobBackend, {
      port: 0,
      sqlitePath: "",
      blobPath: "",
      apiKeySalt: "test-salt",
      corsOrigins: [],
    });

    const res = await request(app, "POST", "/keys", {
      body: { label: "bootstrap-admin" },
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data["role"]).toBe("admin");
    expect(data).toHaveProperty("key");

    storage.close();
  });
});

describe("key management", () => {
  it("creates and lists keys", async () => {
    const createRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: { label: "test-member", role: "member" },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as Record<string, unknown>;
    expect(created["role"]).toBe("member");

    const listRes = await request(ctx.app, "GET", "/keys", {
      key: ctx.adminKey,
    });
    expect(listRes.status).toBe(200);
    const keys = (await listRes.json()) as unknown[];
    expect(keys.length).toBeGreaterThanOrEqual(2);
  });

  it("revokes a key", async () => {
    const createRes = await request(ctx.app, "POST", "/keys", {
      key: ctx.adminKey,
      body: { label: "to-revoke" },
    });
    const created = (await createRes.json()) as Record<string, unknown>;

    const revokeRes = await request(
      ctx.app,
      "DELETE",
      `/keys/${created["id"] as string}`,
      { key: ctx.adminKey },
    );
    expect(revokeRes.status).toBe(204);
  });
});
