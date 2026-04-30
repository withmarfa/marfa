import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { createApp } from "../app.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { createPgStorage } from "../storage/pg/index.js";
import { FilesystemBlobBackend } from "../storage/blob-backend.js";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";

const SALT = "test-salt";

// The default createTestContext() runs in `authMode: "keys"`, where the
// user-auth routes are not mounted. Happy-path coverage needs a
// hosted-mode app, built inline here (mirroring tenants.test.ts).
interface HostedContext {
  app: Hono<AppEnv>;
  storage: Storage;
  cleanup: () => Promise<void>;
}

async function createHostedContext(): Promise<HostedContext> {
  const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
  const tmpDir = mkdtempSync(join(tmpdir(), "myme-users-test-"));
  const blobPath = join(tmpDir, "blobs");

  let storage: Storage;
  if (dialect === "pg") {
    const databaseUrl =
      process.env.DATABASE_URL ??
      "postgres://myme:myme_dev@localhost:5434/myme";
    storage = await createPgStorage(databaseUrl, { authMode: "hosted" });
    const s = storage as unknown as Record<string, unknown>;
    if (typeof s._pgTruncate === "function") {
      await (s._pgTruncate as () => Promise<void>)();
    }
  } else {
    const dbPath = join(tmpDir, "test.db");
    storage = createSqliteStorage(dbPath, { authMode: "hosted" });
  }

  const blobBackend = new FilesystemBlobBackend(blobPath);
  const app = createApp(storage, blobBackend, {
    port: 0,
    storageDialect: dialect as "sqlite" | "pg",
    sqlitePath: "",
    databaseUrl: "",
    blobPath,
    blobBackend: "fs",
    maxBlobSize: 50 * 1024 * 1024,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    apiKeySalt: SALT,
    corsOrigins: [],
    cdnBaseUrl: "",
    authMode: "hosted",
    versionSnapshotIntervalMs: 600_000,
    rateLimitEnabled: false,
    enableHsts: false,
    auditRetentionDays: 90,
    auditCleanupIntervalMs: 86_400_000,
    eventLogRetentionHours: 168,
    versionThinningIntervalMs: 3_600_000,
    versionRecentDays: 30,
    versionDailySnapshotDays: 90,
    versionWeeklySnapshotDays: 365,
    versionMaxVersions: 500,
    trashRetentionDays: 60,
    trashPurgeIntervalMs: 3_600_000,
    feedRetentionDays: 0,
    feedExpiryIntervalMs: 3_600_000,
    errorWebhookUrl: "",
    trustedProxyCidrs: [],
  authBaseUrl: "http://localhost:0",
  authAllowSignup: true,
  authSecret: "test-auth-secret",
  });

  return {
    app,
    storage,
    cleanup: async () => {
      await storage.close();
    },
  };
}

interface User {
  id: string;
  email: string;
  name: string | null;
  provider: string;
  provider_id: string;
  tenant_id: string;
}

interface Tenant {
  id: string;
  name: string | null;
}

interface SignupResponse {
  user: User;
  tenant: Tenant;
  api_key: string;
}

interface SessionResponse {
  user: User;
  api_key: string;
}

interface MeResponse {
  user: User | null;
  tenant: Tenant;
}

interface ErrorBody {
  error: { code: string };
}

function uniqueProvider(prefix: string): {
  provider: string;
  provider_account_id: string;
  email: string;
} {
  const suffix = Math.random().toString(36).slice(2, 10);
  return {
    provider: "test",
    provider_account_id: `${prefix}-${suffix}`,
    email: `${prefix}-${suffix}@example.com`,
  };
}

// ---------------------------------------------------------------------------
// Keys-mode context: user-auth routes are NOT mounted.
// ---------------------------------------------------------------------------

describe("User-auth routes — not mounted under authMode=keys", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(() => {
    ctx.cleanup();
  });

  it("POST /auth/signup returns 404", async () => {
    const res = await request(ctx.app, "POST", "/auth/signup", {
      body: {
        email: "x@example.com",
        provider: "test",
        provider_account_id: "x",
      },
    });
    expect(res.status).toBe(404);
  });

  it("POST /auth/session returns 404", async () => {
    const res = await request(ctx.app, "POST", "/auth/session", {
      body: { provider: "test", provider_account_id: "x" },
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Hosted-mode context: the user-auth routes are mounted.
// ---------------------------------------------------------------------------

describe("User-auth routes — authMode=hosted", () => {
  let hosted: HostedContext;

  beforeAll(async () => {
    hosted = await createHostedContext();
  });

  afterAll(async () => {
    await hosted.cleanup();
  });

  describe("POST /auth/signup", () => {
    it("creates user, tenant, and admin API key (201)", async () => {
      const ident = uniqueProvider("signup-happy");
      const res = await request(hosted.app, "POST", "/auth/signup", {
        body: { ...ident, name: "Happy User" },
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as SignupResponse;
      expect(body.user.email).toBe(ident.email);
      expect(body.user.provider).toBe(ident.provider);
      expect(body.user.provider_id).toBe(ident.provider_account_id);
      expect(body.user.tenant_id).toBe(body.tenant.id);
      expect(body.api_key.startsWith("myme_k1_")).toBe(true);

      // The returned key should actually authenticate — round-trip via /auth/me.
      const me = await request(hosted.app, "GET", "/auth/me", {
        key: body.api_key,
      });
      expect(me.status).toBe(200);
      const meBody = (await me.json()) as MeResponse;
      expect(meBody.user?.id).toBe(body.user.id);
      expect(meBody.tenant.id).toBe(body.tenant.id);
    });

    it("returns 409 on duplicate (provider, provider_account_id)", async () => {
      const ident = uniqueProvider("signup-dup");
      const first = await request(hosted.app, "POST", "/auth/signup", {
        body: ident,
      });
      expect(first.status).toBe(201);

      const second = await request(hosted.app, "POST", "/auth/signup", {
        body: ident,
      });
      expect(second.status).toBe(409);
      const err = (await second.json()) as ErrorBody;
      expect(err.error.code).toBe("conflict");
    });
  });

  describe("POST /auth/session", () => {
    it("exchanges an existing provider identity for an API key (200)", async () => {
      const ident = uniqueProvider("session-happy");
      const signup = await request(hosted.app, "POST", "/auth/signup", {
        body: ident,
      });
      expect(signup.status).toBe(201);
      const signupBody = (await signup.json()) as SignupResponse;

      const res = await request(hosted.app, "POST", "/auth/session", {
        body: {
          provider: ident.provider,
          provider_account_id: ident.provider_account_id,
        },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as SessionResponse;
      expect(body.user.id).toBe(signupBody.user.id);
      expect(body.api_key.startsWith("myme_k1_")).toBe(true);

      // Session key should authenticate too.
      const me = await request(hosted.app, "GET", "/auth/me", {
        key: body.api_key,
      });
      expect(me.status).toBe(200);
    });

    it("returns 404 for an unknown provider identity", async () => {
      const res = await request(hosted.app, "POST", "/auth/session", {
        body: {
          provider: "test",
          provider_account_id: `nobody-${Math.random().toString(36).slice(2)}`,
        },
      });
      expect(res.status).toBe(404);
      const err = (await res.json()) as ErrorBody;
      expect(err.error.code).toBe("not_found");
    });
  });

  describe("GET /auth/me", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const res = await request(hosted.app, "GET", "/auth/me");
      expect(res.status).toBe(401);
    });

    it("returns user + tenant for the authenticated caller (200)", async () => {
      const ident = uniqueProvider("me-happy");
      const signup = await request(hosted.app, "POST", "/auth/signup", {
        body: { ...ident, name: "Me Test" },
      });
      const signupBody = (await signup.json()) as SignupResponse;

      const res = await request(hosted.app, "GET", "/auth/me", {
        key: signupBody.api_key,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as MeResponse;
      expect(body.user?.id).toBe(signupBody.user.id);
      expect(body.user?.email).toBe(ident.email);
      expect(body.tenant.id).toBe(signupBody.tenant.id);
    });
  });
});
