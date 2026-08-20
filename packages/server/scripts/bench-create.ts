/**
 * Create-path latency benchmark over real HTTP against a real Postgres.
 * Exercises the full space-bounded write path — RLS transaction wrapper,
 * rate-limit windows, quota gate — because those are where the create
 * path's round trips live; a space-less admin key would skip most of it.
 *
 * Usage:
 *   DATABASE_URL=postgres://... \
 *     pnpm --filter @withmarfa/server exec tsx scripts/bench-create.ts
 *
 * The database must already be migrated. Prints mean / p50 / p95 / p99
 * over the sampled creates, half plain and half carrying an edge.
 */
import { serve } from "@hono/node-server";
import { createPgStorage } from "../src/storage/pg/index.js";
import { FilesystemBlobBackend } from "../src/storage/blob-backend.js";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/middleware/auth.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.BENCH_PORT ?? 8899);
const WARMUP = 25;
const RUNS = 200;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const storage = await createPgStorage(databaseUrl, { authMode: "keys" });
  const blobDir = mkdtempSync(join(tmpdir(), "bench-create-"));
  const blob = new FilesystemBlobBackend(join(blobDir, "blobs"));
  const app = createApp(storage, blob, {
    port: PORT,
    storageDialect: "pg",
    sqlitePath: "",
    databaseUrl,
    blobPath: "",
    blobBackend: "fs",
    maxBlobSize: 50 * 1024 * 1024,
    maxRequestBytes: 1_048_576,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    apiKeySalt: "bench-salt",
    corsOrigins: [],
    cdnBaseUrl: "",
    authMode: "keys",
    rateLimitEnabled: true,
    rlsEnforce: true,
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
    trashPurgeIntervalMs: 86_400_000,
    errorWebhookUrl: "",
    trustedProxyCidrs: [],
    authBaseUrl: `http://localhost:${String(PORT)}`,
    authAllowSignup: false,
    seedStarterContent: false,
    authSecret: "bench-auth-secret",
    oidcProviders: [],
    rateLimitDefaultLimit: 100_000,
    rateLimitWindowMs: 60_000,
    mcpEnabled: false,
  });

  if (!storage.spaces) throw new Error("PG storage always carries spaces");
  const space = await storage.spaces.create("bench");
  const spaceId = space.id;
  // Random suffix so a second run against the same database does not
  // die on the key hash's unique constraint.
  const raw = `marfa_k1_bench_${randomBytes(6).toString("hex")}`;
  const benchKey = await storage.keys.create(
    {
      label: "bench",
      source: "bench",
      role: "space_admin",
      type_permissions: {},
      default_tier: "library",
    },
    hashApiKey(raw, "bench-salt"),
    spaceId,
  );

  const server = serve({ fetch: app.fetch, port: PORT });
  try {
    const base = `http://127.0.0.1:${String(PORT)}`;
    const create = async (withEdge: string | null): Promise<string> => {
      const res = await fetch(`${base}/items`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "core.note",
          properties: { body: "bench" },
          tags: ["bench"],
          ...(withEdge && { edges: { about: [withEdge] } }),
        }),
      });
      if (res.status !== 201) {
        throw new Error(`create failed: ${String(res.status)}`);
      }
      const parsed = (await res.json()) as { item: { id: string } };
      return parsed.item.id;
    };

    const anchor = await create(null);
    for (let i = 0; i < WARMUP; i++) await create(null);

    const samples: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const target = i % 2 === 0 ? null : anchor;
      const started = performance.now();
      await create(target);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const at = (q: number): number => samples[Math.floor(RUNS * q)] ?? 0;
    console.log(
      `bench-create: ${String(RUNS)} space-bounded POST /items over HTTP (pg, port ${String(PORT)}, half with an inline edge)`,
    );
    console.log(
      JSON.stringify({
        runs: RUNS,
        mean_ms: Number(mean.toFixed(2)),
        p50_ms: Number(at(0.5).toFixed(2)),
        p95_ms: Number(at(0.95).toFixed(2)),
        p99_ms: Number(at(0.99).toFixed(2)),
      }),
    );
  } finally {
    // The bench owns what it creates, on every exit path. The credential
    // is the part that matters: a live space_admin key left behind is
    // not harmless if DATABASE_URL pointed anywhere real. The space is
    // suspended (there is no space delete), which blocks writes through
    // it; the inert bench items stay, which is fine for the scratch
    // database this expects.
    try {
      await storage.keys.revoke(benchKey.id);
      await storage.spaces.suspend(spaceId);
    } catch {
      // The database may already be gone; nothing to clean then.
    }
    server.close();
    await storage.close();
    rmSync(blobDir, { recursive: true, force: true });
  }
}

void main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
