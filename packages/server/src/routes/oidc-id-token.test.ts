// T-090: ID Token issuance, JWKS publication, and OIDC discovery doc.
//
// Locks in the contract that strict OIDC relying parties read:
//   - /auth/token returns `id_token` whenever `openid` is granted
//   - /.well-known/jwks.json publishes the public RSA JWK
//   - /.well-known/openid-configuration advertises the surface
//   - id_token verifies against JWKS (round-trip)

import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { jwtVerify, createLocalJWKSet } from "jose";
import type { Hono } from "hono";
import type { JWK } from "jose";
import { createApp } from "../app.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { createPgStorage } from "../storage/pg/index.js";
import { FilesystemBlobBackend } from "../storage/blob-backend.js";
import { hashApiKey } from "../middleware/auth.js";
import { OidcSigner } from "../auth/oidc-signing.js";
import { request } from "../test-utils.js";
import type { AppEnv } from "../middleware/auth.js";
import type { Storage } from "../storage/interface.js";

const SALT = "test-salt";
const AUTH_BASE_URL = "http://localhost:0";

interface HostedCtx {
  app: Hono<AppEnv>;
  storage: Storage;
  cleanup: () => Promise<void>;
}

async function createHosted(): Promise<HostedCtx> {
  const dialect = process.env.STORAGE_DIALECT ?? "sqlite";
  const tmpDir = mkdtempSync(join(tmpdir(), "myme-oidc-test-"));
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
  const oidcSigner = await OidcSigner.init(storage);
  const app = createApp(
    storage,
    blobBackend,
    {
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
      authBaseUrl: AUTH_BASE_URL,
      authAllowSignup: true,
      authSecret: "test-auth-secret",
      oidcProviders: [],
      rateLimitDefaultLimit: 1000,
      rateLimitWindowMs: 60_000,
      oauthRedirectAllowlist: [],
    },
    undefined,
    oidcSigner,
  );

  return {
    app,
    storage,
    cleanup: async () => {
      // Best-effort; real cleanup happens at the dialect layer.
    },
  };
}

/** Mints an OAuth code on a synthetic grant, then exercises the token
 *  endpoint to get a real `id_token`. Bypasses the consent UI. */
async function mintTokenWithScopes(
  hosted: HostedCtx,
  scopes: string[],
  user: { id: string; tenantId: string; clientId: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Synthetic grant in user's tenant.
  const grant = await hosted.storage.items.create(
    {
      type: "system.connection",
      state: "active",
      tier: "library",
      properties: {
        kind: "app",
        client_id: user.clientId,
        scopes,
        oidc_scopes: scopes.filter(
          (s) => s === "openid" || s === "profile" || s === "email",
        ),
        status: "active",
        granted_at: new Date().toISOString(),
      },
      source: "test/oidc-id-token",
    },
    user.tenantId,
  );

  const codeRaw = `oidc-test-${Math.random().toString(36).slice(2)}`;
  const codeHash = hashApiKey(codeRaw, SALT);
  const verifier = "test-verifier-long-enough-for-pkce-hash-input";
  const { createHash } = await import("node:crypto");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  await hosted.storage.oauth.createCode(
    grant.id,
    codeHash,
    challenge,
    "S256",
    "https://example.com/cb",
    new Date(Date.now() + 60_000).toISOString(),
  );

  const res = await request(hosted.app, "POST", "/auth/token", {
    form: {
      grant_type: "authorization_code",
      code: codeRaw,
      code_verifier: verifier,
      redirect_uri: "https://example.com/cb",
    },
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

/** Stand up a hosted-mode user end-to-end (auth_user → tenant → users
 *  row). Mirrors the helper in profile.test.ts. */
async function provisionUser(
  hosted: HostedCtx,
  opts: {
    handle: string;
    email: string;
    firstName?: string;
    lastName?: string;
  },
): Promise<{ id: string; tenantId: string; email: string }> {
  if (!hosted.storage.users || !hosted.storage.tenants) {
    throw new Error("hosted-mode test fixture must wire users + tenants");
  }
  const authUserId = `auth_${Math.random().toString(36).slice(2, 14)}`;
  const now = new Date();

  // Direct insert into auth_user — same shortcut the profile tests take.
  const dialect = (hosted.storage as { betterAuthDialect?: string })
    .betterAuthDialect;
  if (dialect === "pg") {
    const { sql } = await import("drizzle-orm");
    const db = (
      hosted.storage as unknown as {
        pgDb?: { execute: (q: unknown) => Promise<unknown> };
      }
    ).pgDb;
    if (!db) throw new Error("pgDb missing on storage");
    await db.execute(
      sql`INSERT INTO auth_user (id, email, name, email_verified, created_at, updated_at) VALUES (${authUserId}, ${opts.email}, ${"Test User"}, ${true}, ${now.toISOString()}, ${now.toISOString()})`,
    );
  } else {
    const runner = (
      hosted.storage as unknown as {
        __sqliteRun?: (
          query: string,
          params: unknown[],
        ) => Promise<{ changes: number }>;
      }
    ).__sqliteRun;
    if (!runner) throw new Error("sqlite run helper missing on storage");
    await runner(
      "INSERT INTO auth_user (id, email, name, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      [authUserId, opts.email, "Test User", 1, now.getTime(), now.getTime()],
    );
  }

  const tenant = await hosted.storage.tenants.create("Test Tenant");
  const user = await hosted.storage.users.create({
    name: "Test User",
    provider: "test",
    provider_id: authUserId,
    tenant_id: tenant.id,
    handle: opts.handle,
    auth_user_id: authUserId,
  });

  if (opts.firstName !== undefined || opts.lastName !== undefined) {
    await hosted.storage.users.updateProfile(user.id, {
      ...(opts.firstName !== undefined && { first_name: opts.firstName }),
      ...(opts.lastName !== undefined && { last_name: opts.lastName }),
    });
  }

  return { id: user.id, tenantId: tenant.id, email: opts.email };
}

describe("T-090: OIDC id_token + JWKS", () => {
  let hosted: HostedCtx;

  beforeAll(async () => {
    hosted = await createHosted();
  });

  afterAll(async () => {
    await hosted.cleanup();
  });

  describe("/.well-known/jwks.json", () => {
    it("publishes a single RS256 public JWK with kid + use=sig", async () => {
      const res = await request(hosted.app, "GET", "/.well-known/jwks.json");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { keys: JWK[] };
      expect(body.keys).toHaveLength(1);
      const jwk = body.keys[0]!;
      expect(jwk.kty).toBe("RSA");
      expect(jwk.alg).toBe("RS256");
      expect(jwk.use).toBe("sig");
      expect(jwk.kid).toBeTruthy();
      // No private parameters leaked.
      expect(jwk.d).toBeUndefined();
      expect(jwk.p).toBeUndefined();
      expect(jwk.q).toBeUndefined();
    });

    it("sets a sensible Cache-Control header", async () => {
      const res = await request(hosted.app, "GET", "/.well-known/jwks.json");
      const cc = res.headers.get("cache-control") ?? "";
      expect(cc).toContain("max-age=");
    });
  });

  describe("/.well-known/openid-configuration", () => {
    it("advertises jwks_uri + RS256 signing alg", async () => {
      const res = await request(
        hosted.app,
        "GET",
        "/.well-known/openid-configuration",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.issuer).toBe(AUTH_BASE_URL);
      expect(body.jwks_uri).toBe(`${AUTH_BASE_URL}/.well-known/jwks.json`);
      expect(body.id_token_signing_alg_values_supported).toEqual(["RS256"]);
      expect(body.scopes_supported).toEqual(
        expect.arrayContaining(["openid", "profile", "email"]),
      );
      expect(body.userinfo_endpoint).toBe(`${AUTH_BASE_URL}/auth/userinfo`);
      // RFC 8414 §2 + RFC 8628 §4 — revocation + device authorization
      // endpoints. Strict OIDC RPs need both advertised here so they
      // can dispatch sign-out + headless flows without hard-coded paths.
      expect(body.revocation_endpoint).toBe(`${AUTH_BASE_URL}/auth/revoke`);
      expect(body.revocation_endpoint_auth_methods_supported).toEqual(["none"]);
      expect(body.device_authorization_endpoint).toBe(
        `${AUTH_BASE_URL}/auth/device`,
      );
    });

    it("oauth-authorization-server carries the same surface", async () => {
      const res = await request(
        hosted.app,
        "GET",
        "/.well-known/oauth-authorization-server",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.jwks_uri).toBe(`${AUTH_BASE_URL}/.well-known/jwks.json`);
      expect(body.revocation_endpoint).toBe(`${AUTH_BASE_URL}/auth/revoke`);
      expect(body.revocation_endpoint_auth_methods_supported).toEqual(["none"]);
      expect(body.device_authorization_endpoint).toBe(
        `${AUTH_BASE_URL}/auth/device`,
      );
    });
  });

  describe("/auth/token id_token issuance", () => {
    it("returns id_token when openid is granted, verifies against JWKS", async () => {
      const user = await provisionUser(hosted, {
        handle: "olive",
        email: "olive@example.com",
        firstName: "Olive",
        lastName: "Park",
      });
      const { status, body } = await mintTokenWithScopes(
        hosted,
        ["openid", "profile", "email"],
        { id: user.id, tenantId: user.tenantId, clientId: "olive-test-client" },
      );
      expect(status).toBe(200);
      expect(body.id_token).toBeTruthy();

      // Round-trip: fetch JWKS, verify the id_token.
      const jwksRes = await request(
        hosted.app,
        "GET",
        "/.well-known/jwks.json",
      );
      const jwksBody = (await jwksRes.json()) as { keys: JWK[] };
      const jwks = createLocalJWKSet(jwksBody);

      const { payload } = await jwtVerify(body.id_token as string, jwks, {
        issuer: AUTH_BASE_URL,
        audience: "olive-test-client",
      });
      expect(payload.sub).toBe(user.id);
      expect(payload.preferred_username).toBe("olive");
      expect(payload.given_name).toBe("Olive");
      expect(payload.family_name).toBe("Park");
      expect(payload.email).toBe("olive@example.com");
      expect(payload.email_verified).toBe(true);
      expect(typeof payload.iat).toBe("number");
      expect(typeof payload.exp).toBe("number");
    });

    it("omits id_token when openid is NOT granted", async () => {
      const user = await provisionUser(hosted, {
        handle: "noah",
        email: "noah@example.com",
      });
      const { status, body } = await mintTokenWithScopes(
        hosted,
        ["core.note:read"],
        { id: user.id, tenantId: user.tenantId, clientId: "noah-test-client" },
      );
      expect(status).toBe(200);
      expect(body.id_token).toBeUndefined();
    });

    it("omits profile claims when only openid+email are granted", async () => {
      const user = await provisionUser(hosted, {
        handle: "iris",
        email: "iris@example.com",
        firstName: "Iris",
      });
      const { body } = await mintTokenWithScopes(hosted, ["openid", "email"], {
        id: user.id,
        tenantId: user.tenantId,
        clientId: "iris-test-client",
      });
      const jwksRes = await request(
        hosted.app,
        "GET",
        "/.well-known/jwks.json",
      );
      const jwks = createLocalJWKSet((await jwksRes.json()) as { keys: JWK[] });
      const { payload } = await jwtVerify(body.id_token as string, jwks);
      expect(payload.email).toBe("iris@example.com");
      expect(payload.preferred_username).toBeUndefined();
      expect(payload.given_name).toBeUndefined();
    });
  });
});
