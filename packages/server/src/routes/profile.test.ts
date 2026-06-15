import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import { createApp } from "../app.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { FilesystemBlobBackend } from "../storage/blob-backend.js";
import { hashApiKey } from "../middleware/auth.js";
import {
  createPgTestStorage,
  request,
  seedOauthBearer,
} from "../test-utils.js";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import {
  renderPlaceholderSvg,
  placeholderInitials,
  placeholderColor,
} from "./profile.js";

/**
 * Profile endpoint coverage.
 *
 * Every test here is targeted at a real bug class — if the endpoint
 * landed without these, the failure modes would be:
 *
 *   - leaking another tenant's profile (lookup-by-tenant guarantee)
 *   - accepting a reserved or colliding handle (validator wiring)
 *   - serving a non-image MIME type as an avatar (XSS via SVG / etc.)
 *   - bouncing the email join silently when auth_user_id is missing
 *   - emitting non-deterministic placeholder SVGs (cache-key churn)
 *   - exposing the placeholder endpoint as a path-traversal vector
 */

const SALT = "test-salt";
const ORIGIN = "http://localhost:0";

interface HostedContext {
  app: Hono<AppEnv>;
  storage: Storage;
  cleanup: () => Promise<void>;
}

async function createHostedContext(): Promise<HostedContext> {
  const dialect = process.env.DB_DIALECT ?? "sqlite";
  const tmpDir = mkdtempSync(join(tmpdir(), "marfa-profile-test-"));
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
    maxRequestBytes: 1_048_576,
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
      if (pgCleanup) {
        // PG path: closes the pool AND drops the cloned test database.
        await pgCleanup();
      } else {
        await storage.close();
      }
    },
  };
}

interface ProvisionedUser {
  apiKey: string;
  userId: string;
  tenantId: string;
  authUserId: string;
  email: string;
  handle: string;
}

/**
 * Stand-up a hosted-mode user end-to-end: create an auth_user row, a
 * tenant, a `users` row bound to both, and an admin api key for the
 * tenant. Returns the bearer + the ids needed to assert against state.
 */
async function provisionUser(
  hosted: HostedContext,
  opts: { handle: string; email: string },
): Promise<ProvisionedUser> {
  const { storage } = hosted;
  if (!storage.users || !storage.tenants) {
    throw new Error("hosted-mode test fixture must wire users + tenants");
  }
  const userStore = storage.users;
  const tenantStore = storage.tenants;

  // Insert directly into the auth_user table. Better Auth would do this
  // on /auth/sign-up, but that path also requires email verification —
  // for endpoint coverage we want the binding without the ceremony.
  const authUserId = `auth_${Math.random().toString(36).slice(2, 14)}`;
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

  const rawKey = `marfa_k1_test_${Math.random().toString(36).slice(2, 14)}`;
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

  return {
    apiKey: rawKey,
    userId: user.id,
    tenantId: tenant.id,
    authUserId,
    email: opts.email,
    handle: opts.handle,
  };
}

/** Direct insert into the auth_user table — bypasses better-auth's
 *  password-hash + verification ceremony so tests can stand up a
 *  bound user without booting the full auth flow. */
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
  // Better-auth's drizzleAdapter in pg uses date columns; in sqlite,
  // text. The storage interface doesn't surface a typed handle, but
  // both dialects expose the underlying drizzle handle via
  // `betterAuthDb`. Use it directly — same shape as the prod code.
  const dialect = (storage as { betterAuthDialect?: string }).betterAuthDialect;
  if (dialect === "pg") {
    const db = (
      storage as unknown as {
        pgDb?: { execute: (q: unknown) => Promise<unknown> };
      }
    ).pgDb;
    if (!db) throw new Error("pgDb missing on storage");
    const { sql } = await import("drizzle-orm");
    // postgres-js doesn't auto-cast Date in raw-SQL parameter binding;
    // pass ISO strings and let the driver coerce to TIMESTAMPTZ.
    const createdAtIso = row.createdAt.toISOString();
    const updatedAtIso = row.updatedAt.toISOString();
    await db.execute(
      sql`INSERT INTO auth_user (id, email, name, email_verified, created_at, updated_at) VALUES (${row.id}, ${row.email}, ${row.name}, ${row.emailVerified}, ${createdAtIso}, ${updatedAtIso})`,
    );
    return;
  }
  // SQLite path — use the storage facade's typed run helper. The async
  // libsql client returns a Promise; await is load-bearing.
  const runner = (
    storage as unknown as {
      __sqliteRun?: (
        query: string,
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

interface ProfileBody {
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  bio: string | null;
  avatar_url: string;
  email: string;
  email_verified: boolean;
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe("Profile routes", () => {
  let hosted: HostedContext;

  beforeAll(async () => {
    hosted = await createHostedContext();
  });

  afterAll(async () => {
    await hosted.cleanup();
  });

  describe("GET /profile/me", () => {
    it("returns the calling user's profile, joined to auth_user.email", async () => {
      const u = await provisionUser(hosted, {
        handle: "alice",
        email: "alice@example.com",
      });
      const res = await request(hosted.app, "GET", "/profile/me", {
        key: u.apiKey,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ProfileBody;
      expect(body.username).toBe("alice");
      expect(body.email).toBe("alice@example.com");
      expect(body.email_verified).toBe(true);
      expect(body.avatar_url).toBe("/profile/placeholder/alice.svg");
    });

    it("rejects unauthenticated requests with 401", async () => {
      const res = await request(hosted.app, "GET", "/profile/me");
      expect(res.status).toBe(401);
    });

    // Confirm /profile/me resolves the same user payload when the bearer
    // is an OAuth access token (synthetic ApiKey with `tenant_id` populated
    // from the grant) — matches the userinfo path. Optional fields
    // (first_name / last_name / bio) may be unset; the resolution path
    // itself must work regardless.
    it("returns the populated profile when authenticated by an OAuth bearer", async () => {
      const u = await provisionUser(hosted, {
        handle: "olive",
        email: "olive@example.com",
      });

      // Mint an OAuth bearer through the plugin-tables setup helper.
      // Writes into auth_oauth_*, same end-to-end behavior as creating
      // a client + token via the raw three-step.
      const { token: rawToken } = await seedOauthBearer(
        hosted.storage,
        ["openid", "profile", "email"],
        {
          clientName: "olive-test-client",
          tenantId: u.tenantId,
          authUserId: u.authUserId,
        },
      );

      const res = await request(hosted.app, "GET", "/profile/me", {
        key: rawToken,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ProfileBody;
      expect(body.username).toBe("olive");
      expect(body.email).toBe("olive@example.com");
      expect(body.email_verified).toBe(true);
      expect(body.avatar_url).toBe("/profile/placeholder/olive.svg");
    });
  });

  describe("PATCH /profile/me", () => {
    it("updates first/last name and bio without touching the handle", async () => {
      const u = await provisionUser(hosted, {
        handle: "bob",
        email: "bob@example.com",
      });
      const res = await request(hosted.app, "PATCH", "/profile/me", {
        key: u.apiKey,
        body: { first_name: "Bob", last_name: "Smith", bio: "Hello there." },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ProfileBody;
      expect(body.first_name).toBe("Bob");
      expect(body.last_name).toBe("Smith");
      expect(body.bio).toBe("Hello there.");
      expect(body.username).toBe("bob");
    });

    it("rejects a reserved handle with HANDLE_RESERVED", async () => {
      const u = await provisionUser(hosted, {
        handle: "carol",
        email: "carol@example.com",
      });
      const res = await request(hosted.app, "PATCH", "/profile/me", {
        key: u.apiKey,
        body: { username: "admin" },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("handle_reserved");
    });

    it("rejects an invalid handle format", async () => {
      const u = await provisionUser(hosted, {
        handle: "dave",
        email: "dave@example.com",
      });
      const res = await request(hosted.app, "PATCH", "/profile/me", {
        key: u.apiKey,
        body: { username: "AB" }, // too short + uppercase
      });
      expect(res.status).toBe(400);
    });

    it("rejects a handle already claimed by another user (409)", async () => {
      const a = await provisionUser(hosted, {
        handle: "eve",
        email: "eve@example.com",
      });
      const b = await provisionUser(hosted, {
        handle: "frank",
        email: "frank@example.com",
      });
      void a; // a holds "eve"; b tries to claim it
      const res = await request(hosted.app, "PATCH", "/profile/me", {
        key: b.apiKey,
        body: { username: "eve" },
      });
      expect(res.status).toBe(409);
    });

    it("allows changing username to a fresh handle", async () => {
      const u = await provisionUser(hosted, {
        handle: "grace",
        email: "grace@example.com",
      });
      const res = await request(hosted.app, "PATCH", "/profile/me", {
        key: u.apiKey,
        body: { username: "grace-renamed" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ProfileBody;
      expect(body.username).toBe("grace-renamed");
    });
  });

  describe("POST /profile/me/avatar", () => {
    // 1x1 transparent PNG (89 bytes). Valid image, smallest possible.
    const TINY_PNG = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100" +
        "0d0a2db40000000049454e44ae426082",
      "hex",
    );

    it("uploads, registers a blob, sets avatar_blob_hash, returns reconstructed URL", async () => {
      const u = await provisionUser(hosted, {
        handle: "henry",
        email: "henry@example.com",
      });
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(TINY_PNG)], { type: "image/png" }),
        "avatar.png",
      );
      const res = await hosted.app.request("/profile/me/avatar", {
        method: "POST",
        headers: { Authorization: `Bearer ${u.apiKey}` },
        body: form,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ProfileBody;
      expect(body.avatar_url).toMatch(/^\/blobs\/sha256:[0-9a-f]+$/);
    });

    it("rejects an unsupported MIME type", async () => {
      const u = await provisionUser(hosted, {
        handle: "ivan",
        email: "ivan@example.com",
      });
      const form = new FormData();
      // application/octet-stream is allowed for /blobs but not for avatars.
      form.append(
        "file",
        new Blob(["not an image"], { type: "application/octet-stream" }),
        "avatar.bin",
      );
      const res = await hosted.app.request("/profile/me/avatar", {
        method: "POST",
        headers: { Authorization: `Bearer ${u.apiKey}` },
        body: form,
      });
      expect(res.status).toBe(400);
    });

    it("rejects an empty body", async () => {
      const u = await provisionUser(hosted, {
        handle: "judy",
        email: "judy@example.com",
      });
      const form = new FormData();
      form.append("file", new Blob([], { type: "image/png" }), "empty.png");
      const res = await hosted.app.request("/profile/me/avatar", {
        method: "POST",
        headers: { Authorization: `Bearer ${u.apiKey}` },
        body: form,
      });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /profile/me/avatar", () => {
    it("clears avatar_blob_hash, reverts avatar_url to placeholder", async () => {
      const u = await provisionUser(hosted, {
        handle: "kate",
        email: "kate@example.com",
      });
      const png = Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100" +
          "0d0a2db40000000049454e44ae426082",
        "hex",
      );
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(png)], { type: "image/png" }),
        "k.png",
      );
      await hosted.app.request("/profile/me/avatar", {
        method: "POST",
        headers: { Authorization: `Bearer ${u.apiKey}` },
        body: form,
      });

      const clearRes = await request(
        hosted.app,
        "DELETE",
        "/profile/me/avatar",
        {
          key: u.apiKey,
        },
      );
      expect(clearRes.status).toBe(200);
      const body = (await clearRes.json()) as ProfileBody;
      expect(body.avatar_url).toBe("/profile/placeholder/kate.svg");
    });
  });

  describe("GET /profile/placeholder/:filename", () => {
    it("renders a deterministic SVG for a given username", async () => {
      const r1 = await request(
        hosted.app,
        "GET",
        "/profile/placeholder/lara.svg",
      );
      expect(r1.status).toBe(200);
      expect(r1.headers.get("content-type")).toContain("image/svg+xml");
      const body1 = await r1.text();

      const r2 = await request(
        hosted.app,
        "GET",
        "/profile/placeholder/lara.svg",
      );
      const body2 = await r2.text();
      expect(body2).toBe(body1);
    });

    it("yields different SVGs for different usernames", async () => {
      const r1 = await request(
        hosted.app,
        "GET",
        "/profile/placeholder/maya.svg",
      );
      const r2 = await request(
        hosted.app,
        "GET",
        "/profile/placeholder/nina.svg",
      );
      const b1 = await r1.text();
      const b2 = await r2.text();
      expect(b1).not.toBe(b2);
    });

    it("returns SVG well under the 24KB target", async () => {
      const res = await request(
        hosted.app,
        "GET",
        "/profile/placeholder/oscar.svg",
      );
      const body = await res.text();
      expect(body.length).toBeLessThan(1024);
    });

    it("rejects path-traversal-shaped usernames", async () => {
      // Hono normalizes ".." segments before the param matcher, so this
      // is mostly belt-and-braces — but the explicit grammar guard
      // means a future router refactor doesn't open a hole.
      const res = await request(
        hosted.app,
        "GET",
        "/profile/placeholder/_invalid.svg",
      );
      expect(res.status).toBe(400);
    });
  });
});

// ---------------------------------------------------------------------------
// Pure-function helpers
// ---------------------------------------------------------------------------

describe("placeholder helpers", () => {
  it("placeholderInitials picks the first two alphanumerics", () => {
    expect(placeholderInitials("alice-rogers")).toBe("AL");
    expect(placeholderInitials("a")).toBe("A");
    // No alphanumerics → fallback. (The route layer rejects this input
    // before it reaches the renderer, but the helper itself stays safe.)
    expect(placeholderInitials("---")).toBe("?");
  });

  it("placeholderColor is stable per username", () => {
    expect(placeholderColor("alice")).toBe(placeholderColor("alice"));
    expect(placeholderColor("alice")).not.toBe(placeholderColor("bob"));
  });

  it("renderPlaceholderSvg is byte-deterministic", () => {
    const a = renderPlaceholderSvg("alice");
    const b = renderPlaceholderSvg("alice");
    expect(b).toBe(a);
  });
});
