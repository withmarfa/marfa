import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { createApp } from "../app.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { createPgStorage } from "../storage/pg/index.js";
import { FilesystemBlobBackend } from "../storage/blob-backend.js";
import { hashApiKey } from "../middleware/auth.js";
import { request } from "../test-utils.js";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";

/**
 * T-074: GET /auth/userinfo coverage.
 *
 * Failure modes this catches:
 *   - leaking email when only `openid` was granted (scope gating bug)
 *   - leaking profile fields when only `email` was granted
 *   - allowing a raw API key to call userinfo (auth-type confusion)
 *   - missing `sub` in any successful response
 *   - returning email of one user when token belongs to another
 *
 * Bypasses the full OAuth code-exchange dance — mints tokens directly
 * via storage.oauth.createToken and provisions a system.connection of
 * kind: app to hang the grant off. The userinfo endpoint's behaviour
 * is independent of how the token came to be; the consent flow is
 * exercised separately by oauth.test.ts.
 */

const SALT = "test-salt";
const ORIGIN = "http://localhost:0";
const ACCESS_TTL_MS = 3600_000;

interface HostedContext {
  app: Hono<AppEnv>;
  storage: Storage;
  cleanup: () => Promise<void>;
}

async function createHostedContext(): Promise<HostedContext> {
  const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
  const tmpDir = mkdtempSync(join(tmpdir(), "myme-userinfo-test-"));
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
    authBaseUrl: ORIGIN,
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
      await storage.close();
    },
  };
}

interface ProvisionedFlow {
  apiKey: string;
  rawApiKey: string;
  userId: string;
  tenantId: string;
  authUserId: string;
  /** OAuth bearer (myme_at_*) for the userinfo call. */
  accessToken: string;
  /** Connection item id for the system.connection app grant. */
  connectionItemId: string;
}

/** Provision a hosted-mode user + an OAuth grant + an access token with
 *  the requested OIDC scopes. Returns the bearer to send in tests. */
async function provisionFlow(
  hosted: HostedContext,
  opts: {
    handle: string;
    email: string;
    firstName?: string;
    lastName?: string;
    bio?: string;
    scopes: string[];
  },
): Promise<ProvisionedFlow> {
  const { storage } = hosted;
  if (!storage.users || !storage.tenants) {
    throw new Error("hosted-mode test fixture must wire users + tenants");
  }
  const userStore = storage.users;
  const tenantStore = storage.tenants;

  const authUserId = `auth_${randomBytes(6).toString("hex")}`;
  const now = new Date();
  await insertAuthUser(storage, {
    id: authUserId,
    email: opts.email,
    emailVerified: true,
    name: "Test User",
    createdAt: now,
    updatedAt: now,
  });

  const tenant = await tenantStore.create("Test Tenant");
  const user = await userStore.create({
    name: "Test User",
    provider: "test",
    provider_id: authUserId,
    tenant_id: tenant.id,
    handle: opts.handle,
    auth_user_id: authUserId,
  });
  if (opts.firstName || opts.lastName || opts.bio) {
    await userStore.updateProfile(user.id, {
      first_name: opts.firstName ?? null,
      last_name: opts.lastName ?? null,
      bio: opts.bio ?? null,
    });
  }

  // Mint a raw admin api key for the tenant so the test can exercise
  // the "raw api key bearers are rejected" path.
  const rawKey = `myme_k1_test_${randomBytes(6).toString("hex")}`;
  await storage.keys.create(
    {
      label: "test-admin",
      source: "test-admin",
      role: "admin",
      type_permissions: {},
    },
    hashApiKey(rawKey, SALT),
    tenant.id,
  );

  // Create a client + a system.connection of kind: app + an oauth token.
  const client = await storage.oauth.createClient({
    name: "Userinfo Test App",
    redirect_uris: ["https://example.com/cb"],
  });
  const grantedAt = new Date().toISOString();
  const connectionItem = await storage.items.create(
    {
      type: "system.connection",
      tier: "library",
      state: "active",
      properties: {
        kind: "app",
        client_id: client.id,
        scopes: opts.scopes,
        status: "active",
        granted_at: grantedAt,
      },
      source: "myme/oauth/test",
    },
    tenant.id,
  );

  const accessTokenRaw = `myme_at_${randomBytes(16).toString("hex")}`;
  const accessExpiresAt = new Date(Date.now() + ACCESS_TTL_MS).toISOString();
  await storage.oauth.createToken(
    connectionItem.id,
    hashApiKey(accessTokenRaw, SALT),
    "access",
    accessExpiresAt,
  );

  return {
    apiKey: accessTokenRaw,
    rawApiKey: rawKey,
    userId: user.id,
    tenantId: tenant.id,
    authUserId,
    accessToken: accessTokenRaw,
    connectionItemId: connectionItem.id,
  };
}

async function insertAuthUser(
  storage: Storage,
  row: {
    id: string;
    email: string;
    emailVerified: boolean;
    name: string;
    createdAt: Date;
    updatedAt: Date;
  },
): Promise<void> {
  const dialect = (storage as { betterAuthDialect?: string }).betterAuthDialect;
  if (dialect === "pg") {
    const db = (
      storage as unknown as {
        pgDb?: { execute: (q: unknown) => Promise<unknown> };
      }
    ).pgDb;
    if (!db) throw new Error("pgDb missing on storage");
    const { sql } = await import("drizzle-orm");
    // postgres-js requires string/Buffer/ArrayBuffer in the parameter
    // binder; ISO strings round-trip cleanly into TIMESTAMPTZ columns.
    const createdAtIso = row.createdAt.toISOString();
    const updatedAtIso = row.updatedAt.toISOString();
    await db.execute(
      sql`INSERT INTO auth_user (id, email, name, email_verified, created_at, updated_at) VALUES (${row.id}, ${row.email}, ${row.name}, ${row.emailVerified}, ${createdAtIso}, ${updatedAtIso})`,
    );
    return;
  }
  const runner = (
    storage as unknown as {
      __sqliteRun?: (
        q: string,
        params: unknown[],
      ) => Promise<{ changes: number }>;
    }
  ).__sqliteRun;
  if (!runner) throw new Error("sqlite run helper missing on storage");
  await runner(
    "INSERT INTO auth_user (id, email, name, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [
      row.id,
      row.email,
      row.name,
      row.emailVerified ? 1 : 0,
      row.createdAt.getTime(),
      row.updatedAt.getTime(),
    ],
  );
}

interface UserinfoBody {
  sub?: string;
  username?: string | null;
  preferred_username?: string | null;
  given_name?: string | null;
  family_name?: string | null;
  bio?: string | null;
  picture?: string | null;
  email?: string;
  email_verified?: boolean;
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe("GET /auth/userinfo (T-074)", () => {
  let hosted: HostedContext;

  beforeAll(async () => {
    hosted = await createHostedContext();
  });

  afterAll(async () => {
    await hosted.cleanup();
  });

  it("returns sub only when no OIDC scopes are granted", async () => {
    const f = await provisionFlow(hosted, {
      handle: "alice",
      email: "alice@example.com",
      scopes: ["core.note:read"],
    });
    const res = await request(hosted.app, "GET", "/auth/userinfo", {
      key: f.accessToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UserinfoBody;
    expect(body.sub).toBe(f.userId);
    expect(body.email).toBeUndefined();
    expect(body.username).toBeUndefined();
    expect(body.given_name).toBeUndefined();
  });

  it("returns profile fields only when `profile` scope is granted", async () => {
    const f = await provisionFlow(hosted, {
      handle: "bob",
      email: "bob@example.com",
      firstName: "Bob",
      lastName: "Smith",
      bio: "Hello.",
      scopes: ["openid", "profile"],
    });
    const res = await request(hosted.app, "GET", "/auth/userinfo", {
      key: f.accessToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UserinfoBody;
    expect(body.sub).toBe(f.userId);
    expect(body.username).toBe("bob");
    expect(body.preferred_username).toBe("bob");
    expect(body.given_name).toBe("Bob");
    expect(body.family_name).toBe("Smith");
    expect(body.bio).toBe("Hello.");
    expect(body.picture).toBe("/profile/placeholder/bob.svg");
    // email scope NOT granted → email field absent.
    expect(body.email).toBeUndefined();
    expect(body.email_verified).toBeUndefined();
  });

  it("returns email only when `email` scope is granted", async () => {
    const f = await provisionFlow(hosted, {
      handle: "carol",
      email: "carol@example.com",
      scopes: ["openid", "email"],
    });
    const res = await request(hosted.app, "GET", "/auth/userinfo", {
      key: f.accessToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UserinfoBody;
    expect(body.sub).toBe(f.userId);
    expect(body.email).toBe("carol@example.com");
    expect(body.email_verified).toBe(true);
    // profile scope NOT granted → profile fields absent.
    expect(body.username).toBeUndefined();
    expect(body.given_name).toBeUndefined();
    expect(body.picture).toBeUndefined();
  });

  it("returns the full set when both scopes are granted", async () => {
    const f = await provisionFlow(hosted, {
      handle: "dave",
      email: "dave@example.com",
      firstName: "Dave",
      scopes: ["openid", "profile", "email"],
    });
    const res = await request(hosted.app, "GET", "/auth/userinfo", {
      key: f.accessToken,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UserinfoBody;
    expect(body.sub).toBe(f.userId);
    expect(body.username).toBe("dave");
    expect(body.given_name).toBe("Dave");
    expect(body.email).toBe("dave@example.com");
    expect(body.email_verified).toBe(true);
  });

  it("rejects a raw API key bearer with 403", async () => {
    const f = await provisionFlow(hosted, {
      handle: "eve",
      email: "eve@example.com",
      scopes: ["openid", "profile"],
    });
    const res = await request(hosted.app, "GET", "/auth/userinfo", {
      key: f.rawApiKey, // not the OAuth token
    });
    expect(res.status).toBe(403);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(hosted.app, "GET", "/auth/userinfo");
    expect(res.status).toBe(401);
  });

  it("uses the immutable user id as `sub` (stable across handle changes)", async () => {
    const f = await provisionFlow(hosted, {
      handle: "frank",
      email: "frank@example.com",
      scopes: ["openid", "profile"],
    });
    const before = await request(hosted.app, "GET", "/auth/userinfo", {
      key: f.accessToken,
    });
    const beforeBody = (await before.json()) as UserinfoBody;

    if (!hosted.storage.users) throw new Error("users store missing");
    await hosted.storage.users.setHandle(f.userId, "frank-renamed");

    const after = await request(hosted.app, "GET", "/auth/userinfo", {
      key: f.accessToken,
    });
    const afterBody = (await after.json()) as UserinfoBody;
    expect(afterBody.sub).toBe(beforeBody.sub);
    expect(afterBody.username).toBe("frank-renamed");
  });
});

describe("OAuth discovery doc (T-074)", () => {
  let hosted: HostedContext;

  beforeAll(async () => {
    hosted = await createHostedContext();
  });

  afterAll(async () => {
    await hosted.cleanup();
  });

  it("advertises userinfo_endpoint + scopes_supported", async () => {
    const res = await request(
      hosted.app,
      "GET",
      "/.well-known/oauth-authorization-server",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      userinfo_endpoint?: string;
      scopes_supported?: string[];
    };
    expect(body.userinfo_endpoint).toMatch(/\/auth\/userinfo$/);
    expect(body.scopes_supported).toContain("openid");
    expect(body.scopes_supported).toContain("profile");
    expect(body.scopes_supported).toContain("email");
  });
});
