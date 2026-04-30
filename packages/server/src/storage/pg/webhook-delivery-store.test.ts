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
    await storage.outboundWebhookDeliveries.schedule({
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
        const webhook = await a.outboundWebhooks.create({
          url: "https://example.invalid/hook",
          events: ["item.created"],
        });

        await seedPendingDeliveries(a, 30, webhook.id);

        const now = new Date().toISOString();
        const [claimA, claimB] = await Promise.all([
          a.outboundWebhookDeliveries.getPending(now, 50),
          b.outboundWebhookDeliveries.getPending(now, 50),
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
        const webhook = await storage.outboundWebhooks.create({
          url: "https://example.invalid/hook",
          events: ["item.created"],
        });
        await seedPendingDeliveries(storage, 1, webhook.id);

        const t0 = new Date().toISOString();
        const first = await storage.outboundWebhookDeliveries.getPending(
          t0,
          10,
        );
        expect(first.length).toBe(1);
        const claimedId = first[0]?.id;

        // Immediately re-polling with a now that's still inside the claim
        // window returns nothing — the row is "in flight".
        const second = await storage.outboundWebhookDeliveries.getPending(
          t0,
          10,
        );
        expect(second.length).toBe(0);

        // Polling with a now past the TTL reclaims the row. CLAIM_LOCK_TTL_MS
        // is 60s; simulate the passage by supplying a future "now" to
        // getPending (callers pass their own clock in the real code path).
        const future = new Date(Date.now() + 120_000).toISOString();
        const third = await storage.outboundWebhookDeliveries.getPending(
          future,
          10,
        );
        expect(third.length).toBe(1);
        expect(third[0]?.id).toBe(claimedId);
      } finally {
        await storage.close();
      }
    });
  },
);

describe.skipIf(!isPg || !url)(
  "PgWebhookDeliveryStore.claimById (direct-dispatch fast path)",
  () => {
    it("only one of two concurrent claimById calls wins", async () => {
      // Two connection pools against the same DB, mirroring two
      // processes hitting the direct path on the same row. The CAS guard
      // in the UPDATE (`status = 'pending' AND next_attempt_at <= now`)
      // plus Postgres row-level locking means exactly one wins.
      const a = await createPgStorage(url);
      const b = await createPgStorage(url);
      try {
        await truncate(a);
        const webhook = await a.outboundWebhooks.create({
          url: "https://example.invalid/hook",
          events: ["item.created"],
        });
        // Seed the delivery row in the past so `next_attempt_at <= now`
        // holds for both concurrent claimers.
        const pastIso = new Date(Date.now() - 5_000).toISOString();
        await a.outboundWebhookDeliveries.schedule({
          webhookId: webhook.id,
          event: "item.created",
          payload: `{"i":0}`,
          webhookUrl: "https://example.invalid/hook",
          webhookSecret: "s",
          nextAttemptAt: pastIso,
        });

        // Fetch the id via a listing — no atomic claim yet.
        const deliveries = await a.outboundWebhookDeliveries.list(
          webhook.id,
          1,
        );
        const id = deliveries[0]?.id;
        expect(id).toBeTruthy();

        const now = new Date().toISOString();
        const claimExpiry = new Date(Date.now() + 60_000).toISOString();
        const [resA, resB] = await Promise.all([
          a.outboundWebhookDeliveries.claimById(id!, claimExpiry, now),
          b.outboundWebhookDeliveries.claimById(id!, claimExpiry, now),
        ]);

        const winners = [resA, resB].filter((r) => r !== null);
        expect(winners.length).toBe(1);
      } finally {
        await a.close();
        await b.close();
      }
    });

    it("returns null when the row is already claimed by the poller", async () => {
      const storage = await createPgStorage(url);
      try {
        await truncate(storage);
        const webhook = await storage.outboundWebhooks.create({
          url: "https://example.invalid/hook",
          events: ["item.created"],
        });
        await seedPendingDeliveries(storage, 1, webhook.id);

        // Poller claims it first.
        const now = new Date().toISOString();
        const [claimed] = await storage.outboundWebhookDeliveries.getPending(
          now,
          1,
        );
        expect(claimed).toBeDefined();

        // Direct path arrives after — must see the bumped next_attempt_at
        // and back off.
        const result = await storage.outboundWebhookDeliveries.claimById(
          claimed!.id,
          new Date(Date.now() + 60_000).toISOString(),
          now,
        );
        expect(result).toBeNull();
      } finally {
        await storage.close();
      }
    });
  },
);
