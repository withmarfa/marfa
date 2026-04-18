import { describe, expect, it } from "vitest";
import { createPgStorage } from "./index.js";

// Postgres-only — the atomic claim pattern (UPDATE … FROM SELECT … FOR
// UPDATE SKIP LOCKED RETURNING) depends on MVCC + row locks, which
// better-sqlite3 doesn't provide. The SQLite store preserves the same
// claim-forward shape but serialises writes at the process level.
const isPg = process.env.STORAGE_DIALECT === "pg";
const url = process.env.DATABASE_URL ?? "";

async function truncate(
  storage: Awaited<ReturnType<typeof createPgStorage>>,
): Promise<void> {
  const s = storage as unknown as { _pgTruncate?: () => Promise<void> };
  if (typeof s._pgTruncate === "function") await s._pgTruncate();
}

async function seedPendingDeliveries(
  storage: Awaited<ReturnType<typeof createPgStorage>>,
  count: number,
  webhookId: string,
): Promise<void> {
  const now = new Date().toISOString();
  for (let i = 0; i < count; i += 1) {
    await storage.webhookDeliveries.schedule({
      webhookId,
      event: "item.created",
      payload: `{"i":${String(i)}}`,
      webhookUrl: "https://example.invalid/hook",
      webhookSecret: "s",
      nextAttemptAt: now,
    });
  }
}

describe.skipIf(!isPg || !url)(
  "PgWebhookDeliveryStore.getPending (atomic claim)",
  () => {
    it("never returns the same row to two concurrent callers", async () => {
      // Two Storage instances against the same DB stand in for two server
      // processes racing the poller. Each has its own connection pool, so
      // the SKIP LOCKED semantics are the only thing preventing duplicates.
      const a = await createPgStorage(url);
      const b = await createPgStorage(url);
      try {
        await truncate(a);
        // Register a webhook so the FK on schedule() resolves.
        const webhook = await a.webhooks.create({
          url: "https://example.invalid/hook",
          events: ["item.created"],
        });

        await seedPendingDeliveries(a, 30, webhook.id);

        const now = new Date().toISOString();
        const [claimA, claimB] = await Promise.all([
          a.webhookDeliveries.getPending(now, 50),
          b.webhookDeliveries.getPending(now, 50),
        ]);

        const idsA = new Set(claimA.map((d) => d.id));
        const idsB = new Set(claimB.map((d) => d.id));
        // Every row claimed by exactly one caller.
        expect(claimA.length + claimB.length).toBe(30);
        for (const id of idsA) {
          expect(idsB.has(id)).toBe(false);
        }
      } finally {
        await a.close();
        await b.close();
      }
    });

    it("returns a row to a later poll once the claim TTL expires", async () => {
      const storage = await createPgStorage(url);
      try {
        await truncate(storage);
        const webhook = await storage.webhooks.create({
          url: "https://example.invalid/hook",
          events: ["item.created"],
        });
        await seedPendingDeliveries(storage, 1, webhook.id);

        const t0 = new Date().toISOString();
        const first = await storage.webhookDeliveries.getPending(t0, 10);
        expect(first.length).toBe(1);
        const claimedId = first[0]?.id;

        // Immediately re-polling with a now that's still inside the claim
        // window returns nothing — the row is "in flight".
        const second = await storage.webhookDeliveries.getPending(t0, 10);
        expect(second.length).toBe(0);

        // Polling with a now past the TTL reclaims the row. CLAIM_LOCK_TTL_MS
        // is 60s; simulate the passage by supplying a future "now" to
        // getPending (callers pass their own clock in the real code path).
        const future = new Date(Date.now() + 120_000).toISOString();
        const third = await storage.webhookDeliveries.getPending(future, 10);
        expect(third.length).toBe(1);
        expect(third[0]?.id).toBe(claimedId);
      } finally {
        await storage.close();
      }
    });
  },
);
