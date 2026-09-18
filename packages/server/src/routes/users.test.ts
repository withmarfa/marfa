import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import { createTestContext, request } from "../test-utils.js";
import type { TestContext } from "../test-utils.js";
import { createApp } from "../app.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { FilesystemBlobBackend } from "../storage/blob-backend.js";
import { hashApiKey } from "../middleware/auth.js";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";
import { SPACE_PERMISSIONS } from "@withmarfa/shared";

const SALT = "test-salt";

// The default createTestContext() runs in `authMode: "keys"`, where the
// user-auth routes are not mounted. Happy-path coverage needs a
// hosted-mode app, built inline here (mirroring spaces.test.ts).
//
// Legacy `POST /auth/signup` + `POST /auth/session` retired — Better Auth
// at `/auth/sign-up/email` is the canonical sign-up surface. Tests below
// mint user + space + a working key directly through storage rather than
// driving signup as the test-fixture path.
interface HostedContext {
  app: Hono<AppEnv>;
  storage: Storage;
  cleanup: () => Promise<void>;
}

async function createHostedContext(): Promise<HostedContext> {
  const tmpDir = mkdtempSync(join(tmpdir(), "marfa-users-test-"));
  const blobPath = join(tmpDir, "blobs");

  const dbPath = join(tmpDir, "test.db");
  const storage = await createSqliteStorage(dbPath, { authMode: "hosted" });

  const blobBackend = new FilesystemBlobBackend(blobPath);
  const app = createApp(storage, blobBackend, {
    port: 0,
    sqlitePath: "",
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
    seedStarterContent: false,
    authSecret: "test-auth-secret",
    oidcProviders: [],
    rateLimitDefaultLimit: 1000,
    rateLimitWindowMs: 60_000,
  });

  return {
    app,
    storage,
    cleanup: async () => {
      await storage.close();
      // The directory holds this file's sqlite database and blob
      // root; nothing else removes it.
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

interface User {
  id: string;
  name: string | null;
  provider: string;
  provider_id: string;
  space_id: string;
  handle?: string | null;
  // email + avatar_url are not on the `users` table; auth_user.email is
  // canonical. The /auth/me wire shape no longer returns email — callers
  // reach for /profile/me (joined to auth_user).
}

interface Space {
  id: string;
  name: string | null;
}

interface MeResponse {
  user: User | null;
  space: Space;
}

interface ErrorBody {
  error: { code: string };
}

/**
 * Mints a user + space + admin API key directly through storage —
 * replaces the legacy `POST /auth/signup` fixture path. Returns the raw
 * key so tests can authenticate against `/auth/me` and `/auth/me/handle`.
 */
async function mintUser(
  storage: Storage,
  prefix: string,
  options: { name?: string } = {},
): Promise<{
  user: User;
  space: Space;
  apiKey: string;
  provider: string;
  providerAccountId: string;
}> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const provider = "test";
  const providerAccountId = `${prefix}-${suffix}`;
  const displayName = options.name ?? `${prefix}-${suffix}@example.com`;

  const space = await storage.spaces!.create(displayName);
  const user = (await storage.users!.create({
    name: options.name,
    provider,
    provider_id: providerAccountId,
    space_id: space.id,
  })) as unknown as User;

  const rawKey = `marfa_k1_test_${prefix}_${suffix}`;
  await storage.keys.create(
    {
      label: "admin",
      source: "admin",
      space_permissions: [...SPACE_PERMISSIONS],
      type_permissions: { "*": "write" },
      // Category 2 is levelled, so an absent map means the credential may not
      // even read the profile. The rank this fixture carried used to read past
      // the map; the map now has to say so.
      profile_permissions: { "*": "write" },
    },
    hashApiKey(rawKey, SALT),
    space.id,
  );

  return {
    user,
    space: space as unknown as Space,
    apiKey: rawKey,
    provider,
    providerAccountId,
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

  it("GET /auth/me is not mounted (404)", async () => {
    // Keys-mode skips the explicit userAuthRoutes mount. The Better Auth
    // catch-all under /auth/* returns 404 for routes it doesn't own.
    const res = await request(ctx.app, "GET", "/auth/me");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Retired surfaces — `POST /auth/signup` and `POST /auth/session` no
// longer exist in any mode. Better Auth at `/auth/sign-up/email` is the
// only sign-up path; sign-in goes through `/auth/sign-in/email`.
// ---------------------------------------------------------------------------

describe("Retired legacy provider-identity surfaces", () => {
  let hosted: HostedContext;
  let keysCtx: TestContext;

  beforeAll(async () => {
    hosted = await createHostedContext();
    keysCtx = await createTestContext();
  });

  afterAll(async () => {
    await hosted.cleanup();
    await keysCtx.cleanup();
  });

  it("POST /auth/signup is gone under authMode=hosted", async () => {
    const res = await request(hosted.app, "POST", "/auth/signup", {
      body: {
        email: "x@example.com",
        provider: "test",
        provider_account_id: "x",
      },
    });
    expect([401, 404]).toContain(res.status);
  });

  it("POST /auth/session is gone under authMode=hosted", async () => {
    const res = await request(hosted.app, "POST", "/auth/session", {
      body: { provider: "test", provider_account_id: "x" },
    });
    expect([401, 404]).toContain(res.status);
  });

  it("POST /auth/signup is gone under authMode=keys", async () => {
    const res = await request(keysCtx.app, "POST", "/auth/signup", {
      body: {
        email: "x@example.com",
        provider: "test",
        provider_account_id: "x",
      },
    });
    expect([401, 404]).toContain(res.status);
  });

  it("POST /auth/session is gone under authMode=keys", async () => {
    const res = await request(keysCtx.app, "POST", "/auth/session", {
      body: { provider: "test", provider_account_id: "x" },
    });
    expect([401, 404]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// Hosted-mode happy paths against the surviving routes.
// ---------------------------------------------------------------------------

describe("User-auth routes — authMode=hosted", () => {
  let hosted: HostedContext;

  beforeAll(async () => {
    hosted = await createHostedContext();
  });

  afterAll(async () => {
    await hosted.cleanup();
  });

  describe("GET /auth/me", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const res = await request(hosted.app, "GET", "/auth/me");
      expect(res.status).toBe(401);
    });

    it("returns user + space for the authenticated caller (200)", async () => {
      const minted = await mintUser(hosted.storage, "me-happy", {
        name: "Me Test",
      });
      const res = await request(hosted.app, "GET", "/auth/me", {
        key: minted.apiKey,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as MeResponse;
      expect(body.user?.id).toBe(minted.user.id);
      expect(body.user?.provider_id).toBe(minted.providerAccountId);
      expect(body.space.id).toBe(minted.space.id);
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
      const minted = await mintUser(hosted.storage, "handle-happy", {
        name: "Handle Test",
      });

      const res = await request(hosted.app, "PUT", "/auth/me/handle", {
        key: minted.apiKey,
        body: { handle: minted.providerAccountId },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: User };
      expect(body.user.handle).toBe(minted.providerAccountId);
    });

    it("rejects a reserved namespace root with 400 handle_reserved", async () => {
      const minted = await mintUser(hosted.storage, "reserved-root", {
        name: "Reserved Test",
      });

      const res = await request(hosted.app, "PUT", "/auth/me/handle", {
        key: minted.apiKey,
        body: { handle: "core" },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("handle_reserved");
    });

    it("accepts a handle that only names a company or a page", async () => {
      // The namespace roots are the whole reservation. A handle is never
      // a route here, so a word like `google` costs nothing to hand out,
      // and refusing it was a defense against a collision this platform
      // cannot have.
      const minted = await mintUser(hosted.storage, "ordinary-word", {
        name: "Ordinary Test",
      });

      const res = await request(hosted.app, "PUT", "/auth/me/handle", {
        key: minted.apiKey,
        body: { handle: "google" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: User };
      expect(body.user.handle).toBe("google");
    });

    it("rejects a malformed handle with 400 validation_error", async () => {
      const minted = await mintUser(hosted.storage, "malformed", {
        name: "Malformed Test",
      });

      const res = await request(hosted.app, "PUT", "/auth/me/handle", {
        key: minted.apiKey,
        body: { handle: "--abc" },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.code).toBe("validation_error");
    });

    it("rejects an already-claimed handle with 409 conflict", async () => {
      const a = await mintUser(hosted.storage, "collide-a", { name: "A" });
      const b = await mintUser(hosted.storage, "collide-b", { name: "B" });

      const taken = `taken-${Math.random().toString(36).slice(2, 10)}`;
      const claim = await request(hosted.app, "PUT", "/auth/me/handle", {
        key: a.apiKey,
        body: { handle: taken },
      });
      expect(claim.status).toBe(200);

      const collide = await request(hosted.app, "PUT", "/auth/me/handle", {
        key: b.apiKey,
        body: { handle: taken },
      });
      expect(collide.status).toBe(409);
      const body = (await collide.json()) as ErrorBody;
      expect(body.error.code).toBe("conflict");
    });
  });
});
