import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { WebhookDelivery } from "../../client/types.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  DAY_MS,
  HOUR_MS,
  movedClock,
  QUIET_SCHEDULE,
  quiet,
} from "../../utils/moved-clock.js";
import { waitFor } from "../../utils/wait.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";

/**
 * What an outbound delivery's history keeps, for how long, and what a
 * redelivery does with it.
 *
 * A server of its own, because a delivery's age is the one thing no request
 * can set: each case writes its deliveries as the server's clock moves
 * forward through the target interface, then asks over HTTP what the server
 * does with them. The instance's audit retention is pinned so the edges are
 * written against a number the file chose, and no cleanup job is due however
 * far the clock goes, so a sweep runs only when the file runs it.
 */
const RETENTION_DAYS = 30;
const MINUTE_MS = 60_000;
/** The longest wait between two attempts of one delivery. */
const LONGEST_BACKOFF_MS = 15_625_000;

let server: FreshServer | undefined;
let clock: ReturnType<typeof movedClock>;
let receiver: Receiver;
/** What the receiver answers each delivery with. */
let answer = 400;

beforeAll(async () => {
  server = await bootFreshServer("webhook-history", {
    ...QUIET_SCHEDULE,
    AUDIT_RETENTION_DAYS: String(RETENTION_DAYS),
  });
  clock = movedClock(server);
  receiver = await startReceiver({ status: () => answer });
  await quiet(server, ["audit-cleanup"]);
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

function manager(): MarfaClient {
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
      const ran = await manager().runHousekeeping(name);
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

/** The deliveries of a subscription that have settled as `status`, once
 *  there are `count` of them. */
async function settledAs(
  webhookId: string,
  status: WebhookDelivery["status"],
  count: number,
): Promise<WebhookDelivery[]> {
  return waitFor(`${String(count)} deliveries to be ${status}`, async () => {
    const rows = (await deliveries(webhookId)).filter(
      (row) => row.status === status,
    );
    return rows.length === count ? rows : undefined;
  });
}

/** The delivery among `rows` that is not any of `known`. */
function newest(
  rows: readonly WebhookDelivery[],
  known: readonly WebhookDelivery[],
): WebhookDelivery {
  const fresh = rows.filter((row) => !known.some((k) => k.id === row.id));
  expect(fresh).toHaveLength(1);
  return fresh[0]!;
}

const RETENTION_MS = RETENTION_DAYS * DAY_MS;

describe("an outbound delivery's history", () => {
  it("refuses to redeliver a dead_letter delivery older than the audit retention", async () => {
    const id = await subscribe("redeliver-expired");
    try {
      await write("redeliver-expired");
      const [older] = await settled(id, 1, "dead_letter");
      await clock.advance(2 * MINUTE_MS);
      await write("redeliver-expired-younger");
      const younger = newest(await settledAs(id, "dead_letter", 2), [older!]);
      // The older is a minute past the retention and the younger a minute
      // inside it.
      await clock.advance(RETENTION_MS - MINUTE_MS);

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
      const accepted = await redeliver(id, younger.id);
      expect(accepted.status, JSON.stringify(accepted.error)).toBe(202);
      expect(accepted.data).toMatchObject({
        id: younger.id,
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
      await clock.advance(RETENTION_MS - MINUTE_MS);

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
      await clock.advance(10 * RETENTION_MS);

      await run("audit-cleanup");

      // The witness that the sweep reaches rows this old: the delivery of the
      // same age that had settled is gone, and the pending one is not.
      const remaining = await deliveries(id);
      expect(remaining.some((row) => row.id === delivered!.id)).toBe(false);
      expect(remaining.find((row) => row.id === pending!.id)).toMatchObject({
        status: "pending",
      });

      // And what it kept is what was needed to send it: the receiver takes
      // it on the next attempt. A poll between the move and the sweep may
      // have tried it again and set the next attempt a backoff on, so the
      // clock moves past that too.
      answer = 200;
      await clock.advance(DAY_MS);
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
      // An hour inside the retention, so the redelivery is accepted.
      await clock.advance(RETENTION_MS - HOUR_MS);
      const accepted = await redeliver(id, failed!.id);
      expect(
        accepted.status,
        `the redelivery was refused: ${JSON.stringify(accepted.error)}`,
      ).toBe(202);
      const again = await waitFor("the redelivery to be refused", async () => {
        await run("webhook-poll");
        const row = (await deliveries(id)).find((r) => r.id === failed!.id);
        return row?.status === "dead_letter" && row.attempt === 2
          ? row
          : undefined;
      });
      // The row still says when it began: a redelivery did not start it over.
      expect(again.created_at).toBe(failed!.created_at);

      // The original instant is now past the retention, and the redelivery
      // an hour or two old.
      await clock.advance(2 * HOUR_MS);
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
      const [oldSuccess] = await settledAs(id, "success", 1);
      answer = 400;
      await write("history-deleted-failed-old");
      const [oldFailed] = await settledAs(id, "dead_letter", 1);
      await clock.advance(2 * MINUTE_MS);
      answer = 200;
      await write("history-deleted-success-young");
      const youngSuccess = newest(await settledAs(id, "success", 2), [
        oldSuccess!,
      ]);
      answer = 400;
      await write("history-deleted-failed-young");
      const youngFailed = newest(await settledAs(id, "dead_letter", 2), [
        oldFailed!,
      ]);
      await clock.advance(RETENTION_MS - MINUTE_MS);

      const result = (await run("audit-cleanup")) as { deliveries: number };

      expect(result.deliveries).toBeGreaterThanOrEqual(2);
      const remaining = (await deliveries(id)).map((row) => row.id).sort();
      expect(remaining).toEqual([youngSuccess.id, youngFailed.id].sort());
    } finally {
      await unsubscribe(id);
    }
  });

  it("starts a fresh cycle of attempts on redelivery", async () => {
    const id = await subscribe("history-cycle");
    try {
      answer = 503;
      await write("history-cycle");
      const sent = () =>
        receiver.received.filter((r) => r.path === "/hook/history-cycle")
          .length;
      // Advance past the longest backoff so retries do not wait on real time.
      const cycle = async (from: number): Promise<WebhookDelivery> => {
        let recorded = from;
        for (let round = 0; round < 12; round += 1) {
          await run("webhook-poll");
          const current = await waitFor(
            "an attempt to be recorded",
            async () => {
              const [only] = await deliveries(id);
              return only !== undefined && only.attempt > recorded
                ? only
                : undefined;
            },
          );
          recorded = current.attempt;
          if (current.status === "dead_letter") return current;
          expect(current, `after attempt ${String(recorded)}`).toMatchObject({
            status: "pending",
            status_code: 503,
          });
          await clock.advance(LONGEST_BACKOFF_MS + 1000);
        }
        throw new Error("the delivery never gave up");
      };

      // A cycle holds eight attempts. The delivery has used them when it
      // gives up, which is the state a redelivery starts from.
      const first = await cycle(0);
      expect(first).toMatchObject({ status_code: 503, attempt: 8 });

      const sentBefore = sent();
      const accepted = await redeliver(id, first.id);
      expect(accepted.status, JSON.stringify(accepted.error)).toBe(202);
      expect(accepted.data).toMatchObject({ status: "pending", attempt: 8 });

      const last = await cycle(8);
      expect(last).toMatchObject({ status_code: 503, attempt: 16 });
      expect(sent() - sentBefore).toBe(8);
    } finally {
      await unsubscribe(id);
    }
  });
});
