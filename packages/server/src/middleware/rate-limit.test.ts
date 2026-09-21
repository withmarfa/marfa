import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PERMISSIONS } from "@withmarfa/shared";
import { createApp } from "../app.js";
import { ensureInstanceId } from "../storage/instance-id.js";
import { createSqliteStorage } from "../storage/sqlite/index.js";
import { createBlobLayer } from "../storage/blob-layer.js";
import { hashApiKey } from "./auth.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Storage } from "../storage/interface.js";
import type { Hono } from "hono";
import type { AppEnv } from "./auth.js";

const SALT = "test-salt";

interface Ctx {
  app: Hono<AppEnv>;
  storage: Storage;
  /** An ordinary working key — the shape an operator is handed, and the
   *  only shape that carries content reach. */
  workingKey: string;
  cleanup: () => Promise<void>;
}

// Build an app with rate limiting ENABLED and an intentionally tiny
// per-window limit, so we can observe per-credential isolation in a
// handful of requests rather than thousands.
async function buildCtx(): Promise<Ctx> {
  // Rate-limit values now flow through AppConfig (single env-read site
  // lives in loadConfig). Set them directly on the literal below; the
  // middleware no longer reads process.env.
  const tmpDir = mkdtempSync(join(tmpdir(), "marfa-ratelimit-"));
  const storage = await createSqliteStorage(join(tmpDir, "test.db"));
  const instanceId = await ensureInstanceId(storage.settings);
  const blobs = await createBlobLayer(storage, {
    blobPath: join(tmpDir, "blobs"),
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
  });
  const app = createApp(
    storage,
    blobs,
    {
      port: 0,
      sqlitePath: "",
      blobPath: join(tmpDir, "blobs"),
      maxRequestBytes: 1_048_576,
      s3Bucket: "",
      s3Region: "us-east-1",
      s3Endpoint: "",
      s3AccessKeyId: "",
      s3SecretAccessKey: "",
      apiKeySalt: SALT,
      corsOrigins: [],
      rateLimitEnabled: true,
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
      authSecret: "test-auth-secret",
      rateLimitDefaultLimit: 2,
      rateLimitWindowMs: 60_000,
      // Disable the aggregate per-identifier window for the per-path /
      // per-credential isolation tests below — several reuse one shared
      // (unauthenticated) IP identifier across many paths in a single
      // window, which the aggregate cap would otherwise trip. The
      // aggregate window has its own dedicated test context.
      rateLimitAggregateMultiplier: 0,
    },
    instanceId,
  );

  const suffix = Math.random().toString(36).slice(2, 14);
  const rawKey = `marfa_k1_rl_working_${suffix}`;
  await storage.keys.create(
    {
      label: "rl-working",
      source: `rl-working-${suffix}`,
      is_operator: false,
      permissions: [...PERMISSIONS],
      type_permissions: { "*": "write" },
      default_tier: "feed",
    },
    hashApiKey(rawKey, SALT),
  );
  await storage.settings.set("bootstrapped", "true");

  return {
    app,
    storage,
    workingKey: rawKey,
    cleanup: async () => {
      try {
        await storage.close();
      } catch {
        // Best-effort.
      }
      delete process.env.RATE_LIMIT_REQUESTS;
      delete process.env.RATE_LIMIT_WINDOW_MS;
    },
  };
}

async function makeWorkingKey(ctx: Ctx, label: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const res = await ctx.app.request("/keys", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.workingKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      label,
      source: `${label}-${suffix}`,
      // Narrow on every axis the caller could have handed down.
      permissions: [],
      default_tier: "feed",
      type_permissions: { "*": "read" },
      extension_permissions: {},
      edge_permissions: {},
    }),
  });
  const body = (await res.json()) as { key: string };
  return body.key;
}

let ctx: Ctx;

beforeAll(async () => {
  ctx = await buildCtx();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("rate-limit keying", () => {
  it("limits per credential, not per IP, for authenticated requests", async () => {
    // Two different working keys (so they have distinct credential ids).
    const keyA = await makeWorkingKey(ctx, "rl-a");
    const keyB = await makeWorkingKey(ctx, "rl-b");

    // Limit is 2/window on non-GET, default*2 on GET. Use GET /items which
    // resolves to limit=4. Issue 5 as key A — last one must 429.
    const hitA = async () =>
      ctx.app.request("/items", {
        headers: { Authorization: `Bearer ${keyA}` },
      });
    const hitB = async () =>
      ctx.app.request("/items", {
        headers: { Authorization: `Bearer ${keyB}` },
      });

    for (let i = 0; i < 4; i++) {
      const res = await hitA();
      expect(res.status).toBe(200);
    }
    const overflow = await hitA();
    expect(overflow.status).toBe(429);

    // Key B must NOT be limited — this is the per-credential property.
    // If keying were IP-based both keys would share the bucket and B
    // would also get 429.
    const bFirst = await hitB();
    expect(bFirst.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Per-path caps for the /auth/oauth2/* endpoints
// ---------------------------------------------------------------------------

describe("rate-limit per-path caps for /auth/oauth2/*", () => {
  // The default cap on this test context is 2 (rateLimitDefaultLimit). The
  // pathLimits map sets per-path caps for /auth/oauth2/* paths so they
  // get their own (larger) budget independent of the global default. We
  // verify the override by hitting an OAuth2 path more times than the
  // default cap would allow.
  //
  // Unauthenticated paths are used so no credential is needed — rate-limit
  // middleware keys by IP for unauthenticated requests.

  it("/auth/oauth2/register has its own cap (does NOT inherit default cap of 2)", async () => {
    // /auth/oauth2/register cap is 10/min — much higher than the test
    // default of 2. Hitting it 5 times should NEVER hit the default
    // ceiling. We don't care if the requests succeed at the application
    // layer (they may 400 on malformed body); we care that NONE return
    // 429 inside the cap window.
    let observed429 = false;
    for (let i = 0; i < 5; i++) {
      const res = await ctx.app.request("/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}), // bad body — plugin will 400 on validation
      });
      if (res.status === 429) observed429 = true;
    }
    expect(observed429).toBe(false);
  });

  it("/auth/oauth2/token has its own cap (does NOT inherit default cap of 2)", async () => {
    let observed429 = false;
    for (let i = 0; i < 5; i++) {
      const res = await ctx.app.request("/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=bogus",
      });
      if (res.status === 429) observed429 = true;
    }
    expect(observed429).toBe(false);
  });

  it("/auth/authorize/decision has its own cap (cap=30)", async () => {
    let observed429 = false;
    for (let i = 0; i < 5; i++) {
      const res = await ctx.app.request("/auth/authorize/decision", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "accept=true",
      });
      if (res.status === 429) observed429 = true;
    }
    expect(observed429).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Aggregate per-identifier window — caps a single identifier across path
// groups so its budget can't multiply group-by-group.
// ---------------------------------------------------------------------------

// Build a dedicated context with the aggregate window ENABLED at a tight
// multiplier, so a handful of requests across two path groups crosses the
// aggregate cap without exhausting either per-path window.
async function buildAggCtx(): Promise<Ctx> {
  const tmpDir = mkdtempSync(join(tmpdir(), "marfa-ratelimit-agg-"));
  const storage = await createSqliteStorage(join(tmpDir, "test.db"));
  const instanceId = await ensureInstanceId(storage.settings);
  const blobs = await createBlobLayer(storage, {
    blobPath: join(tmpDir, "blobs"),
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
  });
  const app = createApp(
    storage,
    blobs,
    {
      port: 0,
      sqlitePath: "",
      blobPath: join(tmpDir, "blobs"),
      maxRequestBytes: 1_048_576,
      s3Bucket: "",
      s3Region: "us-east-1",
      s3Endpoint: "",
      s3AccessKeyId: "",
      s3SecretAccessKey: "",
      apiKeySalt: SALT,
      corsOrigins: [],
      rateLimitEnabled: true,
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
      authSecret: "test-auth-secret",
      // defaultLimit 2 → GET path window resolves to 4. Aggregate
      // multiplier 2 → aggregate cap = defaultLimit * 2 = 4, keyed on the
      // identifier alone.
      rateLimitDefaultLimit: 2,
      rateLimitWindowMs: 60_000,
      rateLimitAggregateMultiplier: 2,
    },
    instanceId,
  );

  const suffix = Math.random().toString(36).slice(2, 14);
  const rawKey = `marfa_k1_rl_agg_${suffix}`;
  await storage.keys.create(
    {
      label: "rl-agg-working",
      source: `rl-agg-working-${suffix}`,
      is_operator: false,
      permissions: [...PERMISSIONS],
      type_permissions: { "*": "write" },
      default_tier: "feed",
    },
    hashApiKey(rawKey, SALT),
  );
  await storage.settings.set("bootstrapped", "true");

  return {
    app,
    storage,
    workingKey: rawKey,
    cleanup: async () => {
      try {
        await storage.close();
      } catch {
        // Best-effort.
      }
      // The directory holds this file's sqlite database and blob
      // root; nothing else removes it.
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe("rate-limit aggregate per-identifier window", () => {
  let aggCtx: Ctx;

  beforeAll(async () => {
    aggCtx = await buildAggCtx();
  });

  afterAll(async () => {
    await aggCtx.cleanup();
  });

  it("caps a single identifier across path groups before any one group's cap", async () => {
    // Per-path GET window is 4 for each group; aggregate cap is 4 across
    // all groups. Two GETs on /items (per-path /items → 2) then two GETs
    // on /types (per-path /types → 2) leaves BOTH per-path windows at 2
    // (well under 4) but the aggregate identifier window at 4. The fifth
    // request — on either group — crosses the aggregate cap and 429s,
    // proving the budget didn't multiply group-by-group.
    const hitItems = () =>
      aggCtx.app.request("/items", {
        headers: { Authorization: `Bearer ${aggCtx.workingKey}` },
      });
    const hitTypes = () =>
      aggCtx.app.request("/types", {
        headers: { Authorization: `Bearer ${aggCtx.workingKey}` },
      });

    expect((await hitItems()).status).toBe(200);
    expect((await hitItems()).status).toBe(200);
    expect((await hitTypes()).status).toBe(200);
    expect((await hitTypes()).status).toBe(200);

    // Neither per-path window has reached its own cap of 4, but the
    // aggregate identifier window is now at its cap — the next request
    // on any path group is rejected.
    const overflow = await hitTypes();
    expect(overflow.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Per-path window isolation under /auth — a storm on one auth endpoint must
// not 429 a sibling. Pre-fix the window was keyed on the coarse `/auth`
// prefix, so all /auth/* paths shared one counter and a /token storm pushed
// the shared count past a sibling's (lower) cap, 429ing it.
// ---------------------------------------------------------------------------

describe("rate-limit per-path isolation under /auth", () => {
  let isoCtx: Ctx;

  beforeAll(async () => {
    // Fresh context so the windows aren't pre-warmed by the suites above.
    isoCtx = await buildCtx();
  });

  afterAll(async () => {
    await isoCtx.cleanup();
  });

  it("a /auth/oauth2/token storm does not 429 /auth/oauth2/register", async () => {
    // Storm /token 15x — comfortably under its own cap (60) so none 429 on
    // their own window. Pre-fix this pushed the shared `/auth` counter to 15,
    // past /register's cap (10); a subsequent /register would 429. Post-fix
    // each matched path has an independent window, so /register is untouched.
    for (let i = 0; i < 15; i++) {
      const res = await isoCtx.app.request("/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=bogus",
      });
      expect(res.status).not.toBe(429);
    }

    const register = await isoCtx.app.request("/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(register.status).not.toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Response headers on the 429 (and error responses generally)
// ---------------------------------------------------------------------------

describe("rate-limit response headers survive the error handler", () => {
  // The middleware prepares Retry-After and the X-RateLimit-* trio before
  // throwing, and the logger prepares X-Request-ID for every request. The
  // error handler builds a fresh Response, which drops prepared headers
  // unless it copies them — these tests pin the copy, because the published
  // reference promises the headers and the SDK's retry path reads
  // Retry-After.
  it("a 429 carries Retry-After and the X-RateLimit-* trio", async () => {
    const key = await makeWorkingKey(ctx, "rl-headers");
    const hit = async () =>
      ctx.app.request("/items", {
        headers: { Authorization: `Bearer ${key}` },
      });

    for (let i = 0; i < 4; i++) {
      const res = await hit();
      expect(res.status).toBe(200);
    }
    const overflow = await hit();
    expect(overflow.status).toBe(429);

    const retryAfter = Number(overflow.headers.get("Retry-After"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(0);
    expect(retryAfter).toBeLessThanOrEqual(60);

    expect(overflow.headers.get("X-RateLimit-Limit")).toBe("4");
    expect(overflow.headers.get("X-RateLimit-Remaining")).toBe("0");
    const reset = Number(overflow.headers.get("X-RateLimit-Reset"));
    expect(Number.isInteger(reset)).toBe(true);
    expect(reset * 1000).toBeGreaterThan(Date.now() - 1000);
  });

  it("an ordinary error response carries X-Request-ID", async () => {
    const key = await makeWorkingKey(ctx, "rl-reqid");
    const res = await ctx.app.request(
      "/items/019621f0-0000-7000-8000-000000000000",
      { headers: { Authorization: `Bearer ${key}` } },
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Request-ID")).toBeTruthy();
  });
});

describe("rate-limit batched windows", () => {
  let batchCtx: Ctx;

  beforeAll(async () => {
    batchCtx = await buildAggCtx();
  });

  afterAll(async () => {
    await batchCtx.cleanup();
  });

  it("a request the per-credential cap rejects still counts against the aggregate window", async () => {
    // Deliberate inclusive semantics, pinned so a regression in either
    // direction is a red test rather than a silent drift: with the
    // per-path GET cap at 4 and the aggregate also 4, four /items GETs
    // exhaust both together; the fifth is a per-path 429 AND the
    // aggregate has advanced with it, so a first request on a sibling
    // group is refused by the aggregate rather than inheriting a
    // freshly-usable budget.
    const hit = (path: string) =>
      batchCtx.app.request(path, {
        headers: { Authorization: `Bearer ${batchCtx.workingKey}` },
      });
    for (let i = 0; i < 4; i++) {
      expect((await hit("/items")).status).toBe(200);
    }
    // Per-path cap crossed; these rejections keep advancing the
    // aggregate window.
    expect((await hit("/items")).status).toBe(429);
    expect((await hit("/items")).status).toBe(429);
    // First-ever request on a different path group: its own window is
    // empty, so only the aggregate can refuse it — and it does.
    expect((await hit("/types")).status).toBe(429);
  });
});
