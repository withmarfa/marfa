import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgStorage } from "./index.js";
import { cloneTemplate, type PgTemplateClone } from "./test-template.js";

// Postgres-only — the atomic claim pattern (UPDATE … FROM SELECT … FOR
// UPDATE SKIP LOCKED RETURNING) depends on MVCC + row locks, which
// better-sqlite3 doesn't provide. The SQLite store preserves the same
// claim-forward shape but serialises writes at the process level.
const isPg = process.env.DB_DIALECT === "pg";

// One template clone for the whole file. Each test opens fresh
// `createPgStorage` instances against the same clone URL — keeps the
// per-test cost cheap (no CREATE DATABASE FROM TEMPLATE per `it`,
// which under parallel test execution was the load-contention point
// for these tests).
//
// Data isolation between tests: each test creates its own webhook with
// a unique URL, so its rows are filterable from any shared-state
// queries. Tests that look at `getPending` results filter by the
// test's own webhook_id before asserting counts — robust to leftover
// pending deliveries from prior tests in the same file.
let sharedClone: PgTemplateClone | undefined;
let sharedUrl: string | undefined;

beforeAll(async () => {
  if (!isPg) return;
  sharedClone = await cloneTemplate();
  sharedUrl = sharedClone.url;
});

afterAll(async () => {
  if (sharedClone) await sharedClone.drop();
});

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

describe.skipIf(!isPg)(
  "PgWebhookDeliveryStore.getPending (atomic claim)",
  () => {
    it("never returns the same row to two concurrent callers", async () => {
      // Two Storage instances against the same DB stand in for two server
      // processes racing the poller. Each has its own connection pool, so
      // the SKIP LOCKED semantics are the only thing preventing duplicates.
      const a = await createPgStorage(sharedUrl!, {
        maxPoolSize: 3,
        skipBootstrap: true,
      });
      const b = await createPgStorage(sharedUrl!, {
        maxPoolSize: 3,
        skipBootstrap: true,
      });
      try {
        // Register a webhook so the FK on schedule() resolves. Unique
        // URL ensures the deliveries can be filtered out from other
        // tests' state when this clone is shared file-wide.
        const webhook = await a.outboundWebhooks.create({
          url: "https://example.invalid/getPending-concurrent",
          events: ["item.created"],
        });

        await seedPendingDeliveries(a, 30, webhook.id);

        const now = new Date().toISOString();
        const [claimA, claimB] = await Promise.all([
          a.outboundWebhookDeliveries.getPending(now, 50),
          b.outboundWebhookDeliveries.getPending(now, 50),
        ]);

        // Filter to this test's webhook — getPending picks across all
        // pending rows, so other tests' leftovers may appear in the
        // raw result set.
        const minesA = claimA.filter((d) => d.webhook_id === webhook.id);
        const minesB = claimB.filter((d) => d.webhook_id === webhook.id);
        const idsA = new Set(minesA.map((d) => d.id));
        const idsB = new Set(minesB.map((d) => d.id));
        // Every row claimed by exactly one caller.
        expect(minesA.length + minesB.length).toBe(30);
        for (const id of idsA) {
          expect(idsB.has(id)).toBe(false);
        }
      } finally {
        await a.close();
        await b.close();
      }
    });

    it("returns a row to a later poll once the claim TTL expires", async () => {
      const storage = await createPgStorage(sharedUrl!, {
        maxPoolSize: 3,
        skipBootstrap: true,
      });
      try {
        const webhook = await storage.outboundWebhooks.create({
          url: "https://example.invalid/getPending-ttl",
          events: ["item.created"],
        });
        await seedPendingDeliveries(storage, 1, webhook.id);

        const t0 = new Date().toISOString();
        // Use a generous limit (200) — `getPending` orders by
        // `next_attempt_at ASC`, and the prior test in this shared-clone
        // file may have left 30 claimed rows whose next_attempt_at is
        // marginally older than this test's. A limit of 10 would crowd
        // this test's row out. We filter to webhook.id below so the
        // assertion is independent of how many leftover rows came back.
        const first = (
          await storage.outboundWebhookDeliveries.getPending(t0, 200)
        ).filter((d) => d.webhook_id === webhook.id);
        expect(first.length).toBe(1);
        const claimedId = first[0]?.id;

        // Immediately re-polling with a now that's still inside the claim
        // window returns nothing — the row is "in flight".
        const second = (
          await storage.outboundWebhookDeliveries.getPending(t0, 200)
        ).filter((d) => d.webhook_id === webhook.id);
        expect(second.length).toBe(0);

        // Polling with a now past the TTL reclaims the row. CLAIM_LOCK_TTL_MS
        // is 60s; simulate the passage by supplying a future "now" to
        // getPending (callers pass their own clock in the real code path).
        const future = new Date(Date.now() + 120_000).toISOString();
        const third = (
          await storage.outboundWebhookDeliveries.getPending(future, 200)
        ).filter((d) => d.webhook_id === webhook.id);
        expect(third.length).toBe(1);
        expect(third[0]?.id).toBe(claimedId);
      } finally {
        await storage.close();
      }
    });
  },
);

describe.skipIf(!isPg)(
  "PgWebhookDeliveryStore.claimById (direct-dispatch fast path)",
  () => {
    it("only one of two concurrent claimById calls wins", async () => {
      // Two connection pools against the same DB, mirroring two
      // processes hitting the direct path on the same row. The CAS guard
      // in the UPDATE (`status = 'pending' AND next_attempt_at <= now`)
      // plus Postgres row-level locking means exactly one wins.
      const a = await createPgStorage(sharedUrl!, {
        maxPoolSize: 3,
        skipBootstrap: true,
      });
      const b = await createPgStorage(sharedUrl!, {
        maxPoolSize: 3,
        skipBootstrap: true,
      });
      try {
        const webhook = await a.outboundWebhooks.create({
          url: "https://example.invalid/claimById-race",
          events: ["item.created"],
        });
        // Seed the delivery row in the past so `next_attempt_at <= now`
        // holds for both concurrent claimers.
        const pastIso = new Date(Date.now() - 5_000).toISOString();
        await a.outboundWebhookDeliveries.schedule({
          webhookId: webhook.id,
          event: "item.created",
          payload: `{"i":0}`,
          webhookUrl: "https://example.invalid/claimById-race",
          webhookSecret: "s",
          nextAttemptAt: pastIso,
        });

        // Fetch the id via a listing — no atomic claim yet. List filters
        // by webhook_id, so we naturally see only this test's row.
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
      const storage = await createPgStorage(sharedUrl!, {
        maxPoolSize: 3,
        skipBootstrap: true,
      });
      try {
        const webhook = await storage.outboundWebhooks.create({
          url: "https://example.invalid/claimById-already-claimed",
          events: ["item.created"],
        });
        await seedPendingDeliveries(storage, 1, webhook.id);

        // Poller claims this test's only delivery first. Filter to our
        // webhook to avoid grabbing leftover pending rows from a prior
        // test (`getPending` is global across the shared clone).
        const now = new Date().toISOString();
        const allPending = await storage.outboundWebhookDeliveries.getPending(
          now,
          50,
        );
        const claimed = allPending.find((d) => d.webhook_id === webhook.id);
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
