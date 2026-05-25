import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import {
  createPgTestStorage,
  createTestContext,
  request,
} from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { createApp } from "../app.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
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
  const tmpDir = mkdtempSync(join(tmpdir(), "marfa-users-test-"));
  const blobPath = join(tmpDir, "blobs");

  let storage: Storage;
  let pgCleanup: (() => Promise<void>) | undefined;
  if (dialect === "pg") {
    const pg = await createPgTestStorage({ authMode: "hosted" });
    storage = pg.storage;
    pgCleanup = pg.cleanup;
  } else {
    const dbPath = join(tmpDir, "test.db");
    storage = await createSqliteStorage(dbPath, { authMode: "hosted" });
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
    errorWebhookUrl: "",
    trustedProxyCidrs: [],
    authBaseUrl: "http://localhost:0",
    authAllowSignup: true,
    authSecret: "test-auth-secret",
    oidcProviders: [],
    rateLimitDefaultLimit: 1000,
    rateLimitWindowMs: 60_000,
    oauthRedirectAllowlist: [],
  });

  return {
    app,
    storage,
    cleanup: async () => {
      if (pgCleanup) {
        await pgCleanup();
      } else {
        await storage.close();
      }
    },
  };
}

interface User {
  id: string;
  name: string | null;
  provider: string;
  provider_id: string;
  tenant_id: string;
  handle?: string | null;
  // T-074: email + avatar_url dropped from `users`; auth_user.email is
  // canonical. The legacy /auth/signup + /auth/me wire shape no longer
  // returns email — callers reach for /profile/me (joined to auth_user).
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

  afterAll(async () => {
    await ctx.cleanup();
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
      expect(body.user?.provider_id).toBe(ident.provider_account_id);
      expect(body.tenant.id).toBe(signupBody.tenant.id);
    });
  });

  describe("PUT /auth/me/handle", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const res = await request(hosted.app, "PUT", "/auth/me/handle", {
        body: { handle: "alice" },
      });
      expect(res.status).toBe(401);
    });

    it("claims a valid handle and persists it on the user (200)", async () => {
      const ident = uniqueProvider("handle-happy");
      const signup = await request(hosted.app, "POST", "/auth/signup", {
        body: { ...ident, name: "Handle Test" },
      });
      const signupBody = (await signup.json()) as SignupResponse;

      const res = await request(hosted.app, "PUT", "/auth/me/handle", {
        key: signupBody.api_key,
        body: { handle: ident.provider_account_id },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: User };
      expect(body.user.handle).toBe(ident.provider_account_id);
    });

    it("rejects a reserved brand handle with 400 handle_reserved", async () => {
      const ident = uniqueProvider("reserved-brand");
      const signup = await request(hosted.app, "POST", "/auth/signup", {
        body: { ...ident, name: "Reserved Test" },
      });
      const signupBody = (await signup.json()) as SignupResponse;

      const res = await request(hosted.app, "PUT", "/auth/me/handle", {
        key: signupBody.api_key,
        body: { handle: "google" },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("handle_reserved");
    });

    it("rejects a reserved structural word with 400 handle_reserved", async () => {
      const ident = uniqueProvider("reserved-struct");
      const signup = await request(hosted.app, "POST", "/auth/signup", {
        body: { ...ident, name: "Reserved Test" },
      });
      const signupBody = (await signup.json()) as SignupResponse;

      const res = await request(hosted.app, "PUT", "/auth/me/handle", {
        key: signupBody.api_key,
        body: { handle: "admin" },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("handle_reserved");
    });

    it("rejects a reserved namespace root with 400 handle_reserved", async () => {
      const ident = uniqueProvider("reserved-root");
      const signup = await request(hosted.app, "POST", "/auth/signup", {
        body: { ...ident, name: "Reserved Test" },
      });
      const signupBody = (await signup.json()) as SignupResponse;

      const res = await request(hosted.app, "PUT", "/auth/me/handle", {
        key: signupBody.api_key,
        body: { handle: "core" },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("handle_reserved");
    });

    it("rejects a reserved future-namespace handle with 400 handle_reserved", async () => {
      const ident = uniqueProvider("reserved-sync");
      const signup = await request(hosted.app, "POST", "/auth/signup", {
        body: { ...ident, name: "Reserved Test" },
      });
      const signupBody = (await signup.json()) as SignupResponse;

      const res = await request(hosted.app, "PUT", "/auth/me/handle", {
        key: signupBody.api_key,
        body: { handle: "sync" },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("handle_reserved");
    });

    it("rejects a malformed handle with 400 validation_error", async () => {
      const ident = uniqueProvider("malformed");
      const signup = await request(hosted.app, "POST", "/auth/signup", {
        body: { ...ident, name: "Malformed Test" },
      });
      const signupBody = (await signup.json()) as SignupResponse;

      const res = await request(hosted.app, "PUT", "/auth/me/handle", {
        key: signupBody.api_key,
        body: { handle: "--abc" },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_error");
    });

    it("rejects an already-claimed handle with 409 conflict", async () => {
      const a = uniqueProvider("collide-a");
      const b = uniqueProvider("collide-b");
      const sa = await request(hosted.app, "POST", "/auth/signup", {
        body: { ...a, name: "A" },
      });
      const sb = await request(hosted.app, "POST", "/auth/signup", {
        body: { ...b, name: "B" },
      });
      const saBody = (await sa.json()) as SignupResponse;
      const sbBody = (await sb.json()) as SignupResponse;

      const taken = `taken-${Math.random().toString(36).slice(2, 10)}`;
      const claim = await request(hosted.app, "PUT", "/auth/me/handle", {
        key: saBody.api_key,
        body: { handle: taken },
      });
      expect(claim.status).toBe(200);

      const collide = await request(hosted.app, "PUT", "/auth/me/handle", {
        key: sbBody.api_key,
        body: { handle: taken },
      });
      expect(collide.status).toBe(409);
      const body = (await collide.json()) as ErrorBody;
      expect(body.error.code).toBe("conflict");
    });
  });
});
