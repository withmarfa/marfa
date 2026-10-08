import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { WebhookDelivery } from "../../client/types.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { withInstanceDatabase } from "../../utils/instance-database.js";
import { waitFor } from "../../utils/wait.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";

/**
 * What an outbound delivery's history keeps, for how long, and what a
 * redelivery does with it.
 *
 * A server of its own, because a delivery's age is the one thing no request
 * can set: the file ages rows in the stored database while the server is
 * stopped, and then asks over HTTP what the server does with them. The
 * instance's audit retention is pinned so the edges are written against a
 * number the file chose.
 */
const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

let server: FreshServer | undefined;
let receiver: Receiver;
/** What the receiver answers each delivery with. */
let answer = 400;

beforeAll(async () => {
  server = await bootFreshServer("webhook-history", {
    AUDIT_RETENTION_DAYS: String(RETENTION_DAYS),
  });
  receiver = await startReceiver({ status: () => answer });
  // The audit sweep's first run is at boot, and a later one is a day away, so
  // once it has finished, a sweep runs only when the file runs it.
  await waitFor(
    "the audit sweep's first run",
    async () => {
      const jobs = await operator().listHousekeeping();
      return (
        jobs.data.data.find((job) => job.name === "audit-cleanup")
          ?.last_finished_at ?? undefined
      );
    },
    60_000,
  );
}, FRESH_SERVER_TIMEOUT_MS + 60_000);

afterAll(async () => {
  await receiver?.close();
  await stopFreshServers();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function owner(): MarfaClient {
  return new MarfaClient({
    baseUrl: server!.apiUrl,
    apiKey: server!.workingKey,
  });
}

function operator(): MarfaClient {
  return new MarfaClient({
    baseUrl: server!.apiUrl,
    apiKey: server!.managementKey,
  });
}

/** Runs a job, again while the server's own run holds its name. */
async function run(name: string): Promise<unknown> {
  return waitFor(
    `${name} to run`,
    async () => {
      const ran = await operator().runHousekeeping(name);
      if (ran.status === 409) return undefined;
      expect(ran.status, JSON.stringify(ran.error)).toBe(200);
      expect(ran.data.outcome, ran.data.error ?? "").toBe("ok");
      return ran.data.result;
    },
    30_000,
  );
}

/** A subscription of the working key that posts to a path of the receiver. */
async function subscribe(label: string): Promise<string> {
  answer = 400;
  const created = await owner().createWebhook({
    url: receiver.hookUrl(label),
    events: ["item.created"],
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  return created.data.id;
}

async function unsubscribe(id: string): Promise<void> {
  await owner().deleteWebhook(id);
}

async function write(body: string): Promise<void> {
  const note = await owner().createItem({
    type: "core.note",
    properties: { body },
  });
  expect(note.ok, JSON.stringify(note.error)).toBe(true);
}

async function deliveries(webhookId: string): Promise<WebhookDelivery[]> {
  const listed = await owner().listWebhookDeliveries(webhookId, {
    limit: 100,
  });
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  return listed.data.data;
}

/** Writes `count` notes and answers the deliveries they leave, once each has
 *  settled as `status`. */
async function settled(
  webhookId: string,
  count: number,
  status: WebhookDelivery["status"],
): Promise<WebhookDelivery[]> {
  return waitFor(`${String(count)} deliveries to be ${status}`, async () => {
    const rows = await deliveries(webhookId);
    return rows.length === count && rows.every((row) => row.status === status)
      ? rows
      : undefined;
  });
}

/** What the receiver has been sent of one delivery on one of its paths. */
function sentTo(label: string, deliveryId: string) {
  return receiver.received.filter(
    (r) =>
      r.path === `/hook/${label}` &&
      (JSON.parse(r.body) as { delivery_id: string }).delivery_id ===
        deliveryId,
  );
}

function redeliver(webhookId: string, deliveryId: string) {
  return owner().rawRequest<WebhookDelivery>(
    `/webhooks/${webhookId}/deliveries/${deliveryId}/redeliver`,
    { method: "POST" },
  );
}

/** Sets each delivery's `created_at` to `ageMs` before now, while the server
 *  is stopped, and starts it again. */
async function ageDeliveries(
  ages: readonly { id: string; ageMs: number }[],
): Promise<void> {
  await server!.restart({
    whileStopped: () => {
      withInstanceDatabase(server!.sqlitePath, (db) => {
        const set = db.prepare(
          "UPDATE outbound_webhook_deliveries SET created_at = ? WHERE id = ?",
        );
        for (const { id, ageMs } of ages) {
          set.run(new Date(Date.now() - ageMs).toISOString(), id);
        }
      });
    },
  });
}

const pastRetention = RETENTION_DAYS * DAY_MS + MINUTE_MS;
const withinRetention = RETENTION_DAYS * DAY_MS - MINUTE_MS;

describe("an outbound delivery's history", () => {
  it("refuses to redeliver a dead_letter delivery older than the audit retention", async () => {
    const id = await subscribe("redeliver-expired");
    try {
      await write("redeliver-expired");
      await write("redeliver-expired-younger");
      const [younger, older] = await settled(id, 2, "dead_letter");
      await ageDeliveries([
        { id: older!.id, ageMs: pastRetention },
        { id: younger!.id, ageMs: withinRetention },
      ]);

      const refused = await redeliver(id, older!.id);
      expect(refused.status).toBe(409);
      expect(refused.error?.error.code).toBe("conflict");
      expect(
        (await deliveries(id)).find((row) => row.id === older!.id),
      ).toMatchObject({ status: "dead_letter", attempt: 1, status_code: 400 });
      const audit = await owner().listAudit({
        action: "webhook.delivery.redeliver",
        resource_id: older!.id,
      });
      expect(audit.data.data).toHaveLength(0);

      // The witness: a delivery a minute inside the retention is accepted,
      // so the refusal above was about the age.
      const accepted = await redeliver(id, younger!.id);
      expect(accepted.status, JSON.stringify(accepted.error)).toBe(202);
      expect(accepted.data).toMatchObject({
        id: younger!.id,
        status: "pending",
      });
    } finally {
      await unsubscribe(id);
    }
  });

  it("keeps a dead_letter delivery within the audit retention redeliverable", async () => {
    const id = await subscribe("history-dead-letter");
    try {
      await write("history-dead-letter");
      const [kept] = await settled(id, 1, "dead_letter");
      await ageDeliveries([{ id: kept!.id, ageMs: withinRetention }]);

      await run("audit-cleanup");

      expect(
        (await deliveries(id)).find((row) => row.id === kept!.id),
      ).toMatchObject({ status: "dead_letter", attempt: 1, status_code: 400 });
      const accepted = await redeliver(id, kept!.id);
      expect(accepted.status, JSON.stringify(accepted.error)).toBe(202);
      expect(accepted.data.id).toBe(kept!.id);
      // What was kept is what is sent: the same event, a second time.
      await waitFor("the redelivery to be sent", async () => {
        await run("webhook-poll");
        return sentTo("history-dead-letter", kept!.id).length >= 2
          ? true
          : undefined;
      });
      const [first, second] = sentTo("history-dead-letter", kept!.id);
      expect(second!.body).toContain("history-dead-letter");
      expect((JSON.parse(second!.body) as { event_id: string }).event_id).toBe(
        (JSON.parse(first!.body) as { event_id: string }).event_id,
      );
    } finally {
      await unsubscribe(id);
    }
  });

  it("keeps a pending delivery whatever its age", async () => {
    const id = await subscribe("history-pending");
    try {
      answer = 200;
      await write("history-pending-settled");
      const [delivered] = await settled(id, 1, "success");
      answer = 503;
      await write("history-pending");
      const pending = await waitFor("the first attempt", async () =>
        (await deliveries(id)).find(
          (row) => row.id !== delivered!.id && row.attempt >= 1,
        ),
      );
      expect(pending).toMatchObject({ status: "pending", status_code: 503 });
      // Both far past the retention, and the pending one due, so the run
      // below could attempt it as soon as the sweep has had its say.
      await server!.restart({
        whileStopped: () => {
          withInstanceDatabase(server!.sqlitePath, (db) => {
            const aged = new Date(Date.now() - 10 * pastRetention);
            db.prepare(
              "UPDATE outbound_webhook_deliveries SET created_at = ? WHERE id IN (?, ?)",
            ).run(aged.toISOString(), delivered!.id, pending!.id);
            db.prepare(
              "UPDATE outbound_webhook_deliveries SET next_attempt_at = ? WHERE id = ?",
            ).run(new Date(Date.now() - 1000).toISOString(), pending!.id);
          });
        },
      });

      await run("audit-cleanup");

      // The witness that the sweep reaches rows this old: the delivery of the
      // same age that had settled is gone, and the pending one is not.
      const remaining = await deliveries(id);
      expect(remaining.some((row) => row.id === delivered!.id)).toBe(false);
      expect(remaining.find((row) => row.id === pending!.id)).toMatchObject({
        status: "pending",
      });

      // And what it kept is what was needed to send it: the receiver takes
      // it on the next attempt.
      answer = 200;
      await waitFor("the delivery to be sent", async () => {
        await run("webhook-poll");
        const row = (await deliveries(id)).find((r) => r.id === pending!.id);
        return row?.status === "success" ? row : undefined;
      });
    } finally {
      await unsubscribe(id);
    }
  });

  it("measures a redelivered delivery's retention from its original created_at", async () => {
    const id = await subscribe("history-clock");
    try {
      await write("history-clock");
      const [failed] = await settled(id, 1, "dead_letter");
      // Inside the retention by `margin`, long enough to be redelivered after
      // a boot and short enough to wait out.
      const margin = 20_000;
      const original = Date.now() - RETENTION_DAYS * DAY_MS + margin;
      await server!.restart({
        whileStopped: () => {
          withInstanceDatabase(server!.sqlitePath, (db) => {
            db.prepare(
              "UPDATE outbound_webhook_deliveries SET created_at = ? WHERE id = ?",
            ).run(new Date(original).toISOString(), failed!.id);
          });
        },
      });
      const accepted = await redeliver(id, failed!.id);
      expect(
        accepted.status,
        `the redelivery came ${String(Date.now() - original)}ms after the delivery's original instant, past the margin of ${String(margin)}ms`,
      ).toBe(202);
      const again = await waitFor("the redelivery to be refused", async () => {
        await run("webhook-poll");
        const row = (await deliveries(id)).find((r) => r.id === failed!.id);
        return row?.status === "dead_letter" && row.attempt === 2
          ? row
          : undefined;
      });
      // The row still says when it began: a redelivery did not start it over.
      expect(Date.parse(again.created_at)).toBe(original);

      await waitFor(
        "the original instant to pass the retention",
        async () =>
          Date.now() > original + RETENTION_DAYS * DAY_MS ? true : undefined,
        margin + 10_000,
        250,
      );
      await run("audit-cleanup");
      expect(
        (await deliveries(id)).some((row) => row.id === failed!.id),
        "a redelivery gave the delivery's history a new lifetime",
      ).toBe(false);
    } finally {
      await unsubscribe(id);
    }
  });

  it("deletes a delivery's history past the audit retention", async () => {
    const id = await subscribe("history-deleted");
    try {
      // Two settled as success and two as dead_letter, one pair past the
      // retention and one a minute inside it.
      answer = 200;
      await write("history-deleted-success-old");
      await write("history-deleted-success-young");
      const succeeded = await settled(id, 2, "success");
      answer = 400;
      await write("history-deleted-failed-old");
      await write("history-deleted-failed-young");
      const failed = await waitFor("two failed deliveries", async () => {
        const rows = (await deliveries(id)).filter(
          (row) => row.status === "dead_letter",
        );
        return rows.length === 2 ? rows : undefined;
      });
      const [youngSuccess, oldSuccess] = succeeded;
      const [youngFailed, oldFailed] = failed;
      await ageDeliveries([
        { id: oldSuccess!.id, ageMs: pastRetention },
        { id: oldFailed!.id, ageMs: pastRetention },
        { id: youngSuccess!.id, ageMs: withinRetention },
        { id: youngFailed!.id, ageMs: withinRetention },
      ]);

      const result = (await run("audit-cleanup")) as { deliveries: number };

      expect(result.deliveries).toBeGreaterThanOrEqual(2);
      const remaining = (await deliveries(id)).map((row) => row.id).sort();
      expect(remaining).toEqual([youngSuccess!.id, youngFailed!.id].sort());
    } finally {
      await unsubscribe(id);
    }
  });

  it("starts a fresh cycle of attempts on redelivery", async () => {
    const id = await subscribe("history-cycle");
    try {
      await write("history-cycle");
      const [failed] = await settled(id, 1, "dead_letter");
      // A delivery that has used the eight attempts a cycle holds: the state
      // a receiver that failed throughout leaves, which backoff of hours
      // would take to reach.
      await server!.restart({
        whileStopped: () => {
          withInstanceDatabase(server!.sqlitePath, (db) => {
            db.prepare(
              "UPDATE outbound_webhook_deliveries SET attempt = 8 WHERE id = ?",
            ).run(failed!.id);
          });
        },
      });
      answer = 503;
      const accepted = await redeliver(id, failed!.id);
      expect(accepted.status, JSON.stringify(accepted.error)).toBe(202);
      expect(accepted.data).toMatchObject({ status: "pending", attempt: 8 });

      const row = async () =>
        (await deliveries(id)).find((r) => r.id === failed!.id)!;
      const sent = () =>
        receiver.received.filter((r) => r.path === "/hook/history-cycle")
          .length;
      const sentBefore = sent();
      // Each attempt waits for a backoff of seconds and then minutes, so the
      // wait before every attempt is made over while the server is stopped,
      // as a server that was off through it finds it.
      let recorded = 8;
      let last: WebhookDelivery | undefined;
      for (let round = 0; round < 12 && last === undefined; round += 1) {
        await run("webhook-poll");
        const current = await waitFor("an attempt to be recorded", async () => {
          const read = await row();
          return read.attempt > recorded ? read : undefined;
        });
        recorded = current.attempt;
        if (current.status === "dead_letter") {
          last = current;
          break;
        }
        expect(current, `after attempt ${String(recorded)}`).toMatchObject({
          status: "pending",
          status_code: 503,
        });
        await server!.restart({
          whileStopped: () => {
            withInstanceDatabase(server!.sqlitePath, (db) => {
              db.prepare(
                "UPDATE outbound_webhook_deliveries SET next_attempt_at = ? WHERE id = ?",
              ).run(new Date(Date.now() - 1000).toISOString(), failed!.id);
            });
          },
        });
      }
      expect(last, "the delivery never gave up").toBeDefined();
      expect(last).toMatchObject({ status_code: 503, attempt: 16 });
      expect(sent() - sentBefore).toBe(8);
    } finally {
      await unsubscribe(id);
    }
  });
});
