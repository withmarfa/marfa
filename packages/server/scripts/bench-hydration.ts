/**
 * Single-shot benchmark for hydrated GET /items/:id latency.
 * Usage: pnpm --filter @mymehq/server tsx scripts/bench-hydration.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStorage } from "../src/storage/sqlite/index.js";
import { FilesystemBlobBackend } from "../src/storage/blob-backend.js";
import { createApp } from "../src/app.js";
import { hashApiKey } from "../src/middleware/auth.js";

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "bench-"));
  const storage = createSqliteStorage(join(dir, "b.db"));
  const blob = new FilesystemBlobBackend(join(dir, "blobs"));
  const app = createApp(storage, blob, {
    port: 0,
    storageDialect: "sqlite",
    sqlitePath: "",
    databaseUrl: "",
    blobPath: "",
    blobBackend: "fs",
    maxBlobSize: 50 * 1024 * 1024,
    s3Bucket: "",
    s3Region: "us-east-1",
    s3Endpoint: "",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    apiKeySalt: "s",
    corsOrigins: [],
    cdnBaseUrl: "",
    authMode: "keys",
    versionSnapshotIntervalMs: 600000,
    rateLimitEnabled: false,
    enableHsts: false,
    auditRetentionDays: 90,
    auditCleanupIntervalMs: 86400000,
    eventLogRetentionHours: 168,
    versionThinningIntervalMs: 3600000,
    versionRecentDays: 30,
    versionDailySnapshotDays: 90,
    versionWeeklySnapshotDays: 365,
    versionMaxVersions: 500,
    trashRetentionDays: 60,
    trashPurgeIntervalMs: 86_400_000,
    feedRetentionDays: 0,
    feedExpiryIntervalMs: 86_400_000,
    errorWebhookUrl: "",
    trustedProxyCidrs: [],
  });
  const raw = "myme_k1_bench";
  await storage.keys.create(
    {
      label: "b",
      source: "b",
      role: "admin",
      type_permissions: {},
      default_tier: "library",
    },
    hashApiKey(raw, "s"),
  );
  const req = (m: string, p: string, body?: unknown) =>
    app.request(p, {
      method: m,
      headers: {
        Authorization: `Bearer ${raw}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  const mk = async (): Promise<string> => {
    const r = await req("POST", "/items", {
      type: "core.note",
      properties: { body: "x" },
    });
    return ((await r.json()) as { item: { id: string } }).item.id;
  };
  const source = await mk();
  for (let i = 0; i < 25; i++) {
    const t = await mk();
    const edgeType = i < 10 ? "about" : i < 20 ? "derived-from" : "authored-by";
    await req("POST", "/edges", {
      source_id: source,
      target_id: t,
      edge_type: edgeType,
    });
  }

  // warm-up
  for (let i = 0; i < 20; i++) await req("GET", `/items/${source}`);

  const runs = 200;
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    const r = await req("GET", `/items/${source}`);
    await r.json();
    samples.push(performance.now() - s);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const p50 = samples[Math.floor(runs * 0.5)];
  const p95 = samples[Math.floor(runs * 0.95)];
  const p99 = samples[Math.floor(runs * 0.99)];
  const fmt = (n: number | undefined): string =>
    n === undefined ? "-" : n.toFixed(2);
  console.log(
    `GET /items/:id (hydrated, 25 edges across 3 types, sqlite in-process):\n` +
      `  n=${String(runs)}  mean=${mean.toFixed(2)}ms  p50=${fmt(p50)}ms  p95=${fmt(p95)}ms  p99=${fmt(p99)}ms`,
  );
  await storage.close();
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
