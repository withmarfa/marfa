import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import {
  cleanup,
  createTestContext,
  getManagementClient,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext("compliance", "metrics"));
});

afterAll(async () => {
  await cleanup(ctx);
});

interface Metrics {
  items: { total: number; by_state: Record<string, number> };
  blobs: { count: number; total_bytes: number };
  types: { core: number; registered: number };
  keys: { total: number };
  webhooks: { total: number };
  uptime_seconds: number;
  process: Record<string, unknown>;
  storage: {
    database_bytes: number | null;
    wal_bytes: number | null;
    rows: Record<string, number | null>;
  };
}

const sorted = (value: object): string[] => Object.keys(value).sort();

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
    expect(sorted(r.data.types)).toEqual(["core", "registered"]);
    expect(sorted(r.data.items)).toEqual(["by_state", "total"]);
    expect(sorted(r.data.blobs)).toEqual(["count", "total_bytes"]);
    expect(typeof r.data.types.registered).toBe("number");
    expect(typeof r.data.uptime_seconds).toBe("number");

    expect(sorted(r.data.process)).toEqual([
      "cpu_system_seconds",
      "cpu_user_seconds",
      "memory_rss_bytes",
      "memory_rss_peak_bytes",
      "release",
    ]);
    expect(typeof r.data.process.release).toBe("string");
    expect(r.data.process.memory_rss_bytes as number).toBeGreaterThan(0);
    expect(sorted(r.data.storage)).toEqual([
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
});
