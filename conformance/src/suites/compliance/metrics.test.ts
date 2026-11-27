import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  getManagementClient,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";
import { bootFreshServer } from "../../utils/fresh-server.js";
import {
  clientsFor,
  DISK_ONLY,
  ownObjectStore,
  replicateUntilCaughtUp,
} from "../../utils/own-blob-server.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "metrics"));
});

afterAll(async () => {
  await cleanup(ctx);
});

interface BlobTotals {
  count: number;
  total_bytes: number;
}

interface Metrics {
  items: { total: number; by_state: Record<string, number> };
  blobs: BlobTotals & {
    by_kind: Record<"image" | "pdf" | "audio_video" | "other", BlobTotals>;
  };
  types: { core: number; registered: number; plugin: number };
  keys: { total: number };
  webhooks: { total: number };
  uptime_seconds: number;
  process: Record<string, unknown>;
  storage: {
    database_bytes: number | null;
    wal_bytes: number | null;
    blob_volume_free_bytes: number | null;
    blob_volume_size_bytes: number | null;
    rows: Record<string, number | null>;
  };
}

const sorted = (value: object): string[] => Object.keys(value).sort();

async function metrics(operator: MarfaClient): Promise<Metrics> {
  const read = await operator.rawRequest<Metrics>("/metrics");
  expect(read.status, JSON.stringify(read.error)).toBe(200);
  return read.data;
}

describe("the instance's metrics", () => {
  it("reports documented instance-wide counters with instance.read", async () => {
    const operator = getManagementClient();
    const r = await operator.rawRequest<Metrics>("/metrics");
    expect(r.status).toBe(200);
    expect(sorted(r.data)).toEqual([
      "blobs",
      "items",
      "keys",
      "process",
      "storage",
      "types",
      "uptime_seconds",
      "webhooks",
    ]);
    expect(sorted(r.data.types)).toEqual(["core", "plugin", "registered"]);
    expect(sorted(r.data.items)).toEqual(["by_state", "total"]);
    expect(sorted(r.data.blobs)).toEqual(["by_kind", "count", "total_bytes"]);
    expect(typeof r.data.types.registered).toBe("number");
    expect(typeof r.data.uptime_seconds).toBe("number");

    expect(sorted(r.data.process)).toEqual([
      "cpu_system_seconds",
      "cpu_user_seconds",
      "memory_rss_bytes",
      "memory_rss_peak_bytes",
      "version",
    ]);
    expect(typeof r.data.process.version).toBe("string");
    expect(r.data.process.memory_rss_bytes as number).toBeGreaterThan(0);
    expect(sorted(r.data.storage)).toEqual([
      "blob_volume_free_bytes",
      "blob_volume_size_bytes",
      "database_bytes",
      "rows",
      "wal_bytes",
    ]);
    expect(sorted(r.data.storage.rows)).toEqual([
      "audit_log",
      "event_log",
      "items",
      "versions",
    ]);
    for (const [table, rows] of Object.entries(r.data.storage.rows)) {
      expect(typeof rows, `storage.rows.${table}`).toBe("number");
    }
    expect(r.data.storage.rows.items).toBe(r.data.items.total);

    await expectMatchesSchema("GET", "/metrics", 200, r.data);

    // The ordinary content fixture lacks instance.read.
    const refused = await client.rawRequest("/metrics");
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("forbidden");
  });

  it("counts the instance as it stands when asked, with the first request as with any other", async () => {
    const operator = getManagementClient();
    const before = (await operator.rawRequest<Metrics>("/metrics")).data;
    const minted = await operator.createKey({
      label: "metrics-current",
      source: "metrics-current",
    });
    expect(minted.status, JSON.stringify(minted.error)).toBe(201);
    const during = (await operator.rawRequest<Metrics>("/metrics")).data;
    expect(during.keys.total).toBe(before.keys.total + 1);
    expect(during.storage.rows.audit_log).toBeGreaterThan(
      before.storage.rows.audit_log as number,
    );

    expect((await operator.revokeKey(minted.data.id)).status).toBe(200);
    const after = (await operator.rawRequest<Metrics>("/metrics")).data;
    expect(after.keys.total).toBe(before.keys.total);
  });

  it("reports all four blob kinds with zero totals on an empty instance", async () => {
    const server = await bootFreshServer("metrics-empty", DISK_ONLY);
    onTestFinished(() => server.stop());
    const { operator } = clientsFor(server);
    expect((await metrics(operator)).blobs).toEqual({
      count: 0,
      total_bytes: 0,
      by_kind: {
        image: { count: 0, total_bytes: 0 },
        pdf: { count: 0, total_bytes: 0 },
        audio_video: { count: 0, total_bytes: 0 },
        other: { count: 0, total_bytes: 0 },
      },
    });
  });

  it("counts blobs and bytes by media type including blobs kept only in S3", async () => {
    const server = await bootFreshServer("metrics-kinds", ownObjectStore());
    onTestFinished(() => server.stop());
    // Keep scheduled replication from replacing the disk copy.
    await server.pauseClock(true);
    const { operator, working } = clientsFor(server);
    const image = await working.uploadBlob(
      new Uint8Array(11),
      " Image/PNG ; x=y ",
    );
    expect(image.status, JSON.stringify(image.error)).toBe(201);
    for (const [size, type] of [
      [13, "APPLICATION/PDF"],
      [17, "audio/ogg"],
      [19, "video/mp4"],
      [23, "application/x-custom"],
      [29, "image/"],
      [31, "video/mp4/extra"],
      [37, "audio/invalid subtype"],
      [41, ""],
    ] as const) {
      const uploaded = await working.uploadBlob(new Uint8Array(size), type);
      expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(201);
    }
    await replicateUntilCaughtUp(operator, "the object store copies");
    const before = await operator.listBlobCopies(image.data.hash);
    expect(before.status, JSON.stringify(before.error)).toBe(200);
    const disk = before.data.data.find((copy) => copy.kind === "disk");
    expect(disk).toBeDefined();
    const dropped = await operator.deleteBlobCopy(
      image.data.hash,
      disk!.store_id,
    );
    expect(dropped.status, JSON.stringify(dropped.error)).toBe(200);
    const copies = await operator.listBlobCopies(image.data.hash);
    expect(copies.status, JSON.stringify(copies.error)).toBe(200);
    expect(copies.data.data.map((copy) => copy.kind)).toEqual(["s3"]);

    const { blobs } = await metrics(operator);
    expect(blobs.by_kind).toEqual({
      image: { count: 1, total_bytes: 11 },
      pdf: { count: 1, total_bytes: 13 },
      audio_video: { count: 2, total_bytes: 36 },
      other: { count: 5, total_bytes: 161 },
    });
    const kinds = Object.values(blobs.by_kind);
    expect(blobs.count).toBe(kinds.reduce((sum, kind) => sum + kind.count, 0));
    expect(blobs.total_bytes).toBe(
      kinds.reduce((sum, kind) => sum + kind.total_bytes, 0),
    );
  });

  it("reports the blob disk volume figures and uses null for each unreadable figure", async () => {
    const server = await bootFreshServer("metrics-volume", DISK_ONLY);
    onTestFinished(() => server.stop());
    const { operator } = clientsFor(server);
    const { storage } = await metrics(operator);
    expect(storage.blob_volume_size_bytes).toBeGreaterThan(0);
    expect(storage.blob_volume_free_bytes).toBeGreaterThanOrEqual(0);
    expect(storage.blob_volume_free_bytes).toBeLessThanOrEqual(
      storage.blob_volume_size_bytes as number,
    );

    await server.setFault("free:blobs=123456");
    await server.setFault("size:blobs=789012");
    expect((await metrics(operator)).storage).toMatchObject({
      blob_volume_free_bytes: 123456,
      blob_volume_size_bytes: 789012,
    });

    await server.setFault("free:blobs=unknown");
    expect((await metrics(operator)).storage).toMatchObject({
      blob_volume_free_bytes: null,
      blob_volume_size_bytes: 789012,
    });

    await server.setFault("size:blobs=unknown");
    expect((await metrics(operator)).storage).toMatchObject({
      blob_volume_free_bytes: null,
      blob_volume_size_bytes: null,
    });
  });
});
