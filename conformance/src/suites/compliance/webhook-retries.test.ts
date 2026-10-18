import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { WebhookDelivery } from "../../client/types.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { movedClock, runJob } from "../../utils/moved-clock.js";
import { waitFor } from "../../utils/wait.js";
import {
  startReceiver,
  type Receiver,
  type Received,
} from "../../utils/webhook-receiver.js";

/**
 * How long a delivery waits between attempts, and what a restart does to the
 * wait.
 *
 * A server of its own, because the waits run to hours and a fixture reaches
 * them only by moving the server's clock past each one, then running the
 * `webhook-poll` job. The receiver is the harness's: it fails each attempt as
 * the case tells it to, and names a `Retry-After` when the case asks.
 */
const SECOND = 1000;
/** The wait before the next attempt after the first, second, ... failure. */
const SCHEDULE = [1, 5, 25, 125, 625, 3125, 15625].map((s) => s * SECOND);
/** What the real time between an attempt and a check can eat of the margin
 *  before a wait ends. */
const MARGIN_MS = 2 * SECOND;

let server: FreshServer;
let receiver: Receiver;
let clock: ReturnType<typeof movedClock>;

interface Answer {
  status: number;
  retryAfter?: string;
}
/** What the receiver answers the nth attempt on a path with. */
type Plan = (attempt: number) => Answer;
const plans = new Map<string, Plan>();

function answerFor(received: Received): Answer {
  const label = received.path.replace(/^\/hook\//, "");
  const attempt = receiver.received.filter(
    (r) => r.path === received.path,
  ).length;
  const plan = plans.get(label);
  if (plan === undefined) throw new Error(`no plan for ${label}`);
  return plan(attempt);
}

beforeAll(async () => {
  server = await bootFreshServer("webhook-retries");
  clock = movedClock(server);
  receiver = await startReceiver({
    status: (received) => answerFor(received).status,
    headers: (received) => {
      const retryAfter = answerFor(received).retryAfter;
      const none: Record<string, string> = {};
      return retryAfter === undefined ? none : { "Retry-After": retryAfter };
    },
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await receiver?.close();
  await stopFreshServers();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function owner(): MarfaClient {
  return new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}

/** Subscribes to `item.created` at a path of the receiver and writes one
 *  note, which is the delivery the case follows. */
async function begin(label: string, plan: Plan): Promise<string> {
  plans.set(label, plan);
  const created = await owner().createWebhook({
    url: receiver.hookUrl(label),
    events: ["item.created"],
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  await write(label);
  return created.data.id;
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

const arrivals = (label: string): Received[] =>
  receiver.received.filter((r) => r.path === `/hook/${label}`);

/** Waits until the receiver has taken `n` attempts and the server has
 *  recorded the nth, which is when its wait has been chosen. */
async function attemptRecorded(
  label: string,
  webhookId: string,
  n: number,
  status: WebhookDelivery["status"],
): Promise<WebhookDelivery> {
  return waitFor(
    `attempt ${String(n)} of ${label} to be recorded as ${status}`,
    async () => {
      const rows = await deliveries(webhookId);
      return arrivals(label).length >= n &&
        rows.length === 1 &&
        rows[0]!.attempt === n &&
        rows[0]!.status === status
        ? rows[0]
        : undefined;
    },
    60_000,
  );
}

/**
 * Moves the clock through the wait that follows attempt `n`, and runs the
 * poll at the two instants that bound it.
 *
 * `notBeforeMs` is a wait the delivery must not be attempted inside, and
 * `dueMs` one it must be attempted by. Before the clock reaches `dueMs`, the
 * poll runs at `notBeforeMs` less a margin for the real time between the
 * attempt and the poll, and an attempt then is a wait that is too short. The
 * margin is checked against the real time that did pass: on a machine so
 * slow that the margin is gone, the delivery may be due, so that poll proves
 * nothing and its check is left out.
 */
async function waitOut(
  label: string,
  n: number,
  notBeforeMs: number,
  dueMs = notBeforeMs,
): Promise<void> {
  const arrived = arrivals(label)[n - 1]!;
  const early = Math.max(0, notBeforeMs - MARGIN_MS);
  if (early > 0) await clock.advance(early);
  await runJob(server, "webhook-poll");
  const elapsed = Date.now() - arrived.at + early;
  if (elapsed < notBeforeMs) {
    expect(
      arrivals(label).length,
      `attempt ${String(n + 1)} came before ${String(notBeforeMs)} ms had passed`,
    ).toBe(n);
  } else if (arrivals(label).length > n) {
    // On a slow machine the real time alone has ended the wait, and the
    // attempt is made. The clock moves no further, because a move now would
    // come after that attempt and shorten the next wait.
    return;
  }
  await clock.advance(dueMs - early);
  await runJob(server, "webhook-poll");
  expect(
    arrivals(label).length,
    `attempt ${String(n + 1)} had not come when ${String(dueMs)} ms had passed`,
  ).toBeGreaterThan(n);
}

/** A Retry-After date `ms` ahead of the server's clock. */
const dateAhead = (ms: number): string =>
  new Date(clock.now() + ms).toUTCString();

async function end(webhookId: string): Promise<void> {
  await owner().deleteWebhook(webhookId);
}

describe("webhook retry waits", () => {
  it("makes eight attempts with the seven waits of the schedule, then records dead_letter", async () => {
    const failures = [500, 503, 429, 408, 502, 504, 500, 503];
    const id = await begin("schedule", (n) => ({
      status: failures[n - 1] ?? 503,
    }));
    try {
      for (let n = 1; n <= SCHEDULE.length; n += 1) {
        await attemptRecorded("schedule", id, n, "pending");
        await waitOut("schedule", n, SCHEDULE[n - 1]!);
      }
      const last = await attemptRecorded("schedule", id, 8, "dead_letter");
      expect(last.status_code).toBe(503);
      expect(arrivals("schedule")).toHaveLength(8);
      const ids = new Set(
        arrivals("schedule").map(
          (r) => (JSON.parse(r.body) as { delivery_id: string }).delivery_id,
        ),
      );
      expect(ids.size, "one delivery_id across the attempts").toBe(1);

      // The witness that the poll would send a ninth if one were due: the
      // clock goes past the longest wait there is.
      await clock.advance(2 * SCHEDULE[6]!);
      await runJob(server, "webhook-poll");
      expect(arrivals("schedule")).toHaveLength(8);
    } finally {
      await end(id);
    }
  });

  it("waits five minutes for a longer Retry-After in seconds, and the ordinary wait where that is longer", async () => {
    // Attempt 1: ordinary wait 1 s, Retry-After 1 hour, so 5 minutes.
    // Attempt 2: ordinary 5 s, Retry-After 2 minutes, so 2 minutes.
    // Attempts 3 and 4 name none, so 25 s and 125 s.
    // Attempt 5: ordinary 625 s, Retry-After 1 hour, so 625 s, not 5 minutes.
    const answers: Record<number, Answer> = {
      1: { status: 503, retryAfter: "3600" },
      2: { status: 503, retryAfter: "120" },
      3: { status: 503 },
      4: { status: 503 },
      5: { status: 503, retryAfter: "3600" },
    };
    const waits = [300, 120, 25, 125, 625].map((s) => s * SECOND);
    const id = await begin(
      "retry-after-seconds",
      (n) => answers[n] ?? { status: 200 },
    );
    try {
      for (const [index, wait] of waits.entries()) {
        await attemptRecorded("retry-after-seconds", id, index + 1, "pending");
        await waitOut("retry-after-seconds", index + 1, wait);
      }
      const done = await attemptRecorded(
        "retry-after-seconds",
        id,
        6,
        "success",
      );
      expect(done.succeeded).toBe(true);
    } finally {
      await end(id);
    }
  });

  it("reads a Retry-After given as a date against the server's clock, and caps it", async () => {
    // Attempt 1 names a date 3 minutes ahead, which is a wait of a little
    // under 3 minutes (the date has no fraction of a second). Attempt 2 names
    // a date an hour ahead, which is capped at 5 minutes.
    const id = await begin("retry-after-date", (n) =>
      n === 1
        ? { status: 503, retryAfter: dateAhead(180 * SECOND) }
        : n === 2
          ? { status: 503, retryAfter: dateAhead(3600 * SECOND) }
          : { status: 200 },
    );
    try {
      await attemptRecorded("retry-after-date", id, 1, "pending");
      await waitOut("retry-after-date", 1, 175 * SECOND, 180 * SECOND);
      await attemptRecorded("retry-after-date", id, 2, "pending");
      await waitOut("retry-after-date", 2, 300 * SECOND);
      await attemptRecorded("retry-after-date", id, 3, "success");
    } finally {
      await end(id);
    }
  });

  it.each(["SIGTERM", "SIGKILL"] as const)(
    "keeps a delivery's wait across a restart by %s, and attempts it once when the wait ends",
    async (signal) => {
      const label = `restart-${signal.toLowerCase()}`;
      const id = await begin(label, (n) =>
        n === 1 ? { status: 503, retryAfter: "120" } : { status: 200 },
      );
      try {
        await attemptRecorded(label, id, 1, "pending");
        const arrived = arrivals(label)[0]!;
        await server.restart({ signal });
        await runJob(server, "webhook-poll");
        if (Date.now() - arrived.at < 120 * SECOND) {
          expect(
            arrivals(label),
            "the restart attempted the delivery before its wait ended",
          ).toHaveLength(1);
        }

        await clock.advance(120 * SECOND);
        await runJob(server, "webhook-poll");
        await attemptRecorded(label, id, 2, "success");
        // A second run and the server's own cadence find nothing more to send.
        await runJob(server, "webhook-poll");
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect(arrivals(label), "a restart sent an attempt twice").toHaveLength(
          2,
        );
        const bodies = arrivals(label).map(
          (r) => JSON.parse(r.body) as { delivery_id: string },
        );
        expect(bodies[1]!.delivery_id).toBe(bodies[0]!.delivery_id);
      } finally {
        await end(id);
      }
    },
  );

  it("queues each event once for each subscription entitled to it when the server stops while it schedules", async () => {
    plans.set("queued-a", () => ({ status: 200 }));
    plans.set("queued-b", () => ({ status: 200 }));
    plans.set("queued-c", () => ({ status: 200 }));
    const subscribe = async (label: string, events: string[]) => {
      const created = await owner().createWebhook({
        url: receiver.hookUrl(label),
        events,
      });
      expect(created.status, JSON.stringify(created.error)).toBe(201);
      return created.data.id;
    };
    const a = await subscribe("queued-a", ["item.created"]);
    const b = await subscribe("queued-b", ["item.created"]);
    // Entitled to none of what is written.
    const c = await subscribe("queued-c", ["item.deleted"]);
    try {
      // Hold the job before it starts, write the events, then hold it again
      // once it has queued their deliveries and not yet recorded its place
      // in the event log, so the events are all behind it when it stops.
      await server.setFault("hold:housekeeping:webhook-schedule");
      for (const body of ["queued-1", "queued-2", "queued-3"]) {
        await write(body);
      }
      await server.setFault("hold:webhook-schedule:queued");
      await server.clearFault("hold:housekeeping:webhook-schedule");
      await server.waitForHold("hold:webhook-schedule:queued");

      await server.restart({ signal: "SIGKILL" });

      const sent = (label: string) =>
        arrivals(label).map(
          (r) => (JSON.parse(r.body) as { event_id: string }).event_id,
        );
      await waitFor(
        "three deliveries to each entitled subscription",
        async () =>
          sent("queued-a").length >= 3 && sent("queued-b").length >= 3
            ? true
            : undefined,
        60_000,
      );
      // The runs that could queue a second set have run.
      await runJob(server, "webhook-schedule");
      await runJob(server, "webhook-poll");
      await new Promise((resolve) => setTimeout(resolve, 1500));

      for (const [label, webhook] of [
        ["queued-a", a],
        ["queued-b", b],
      ] as const) {
        const events = sent(label);
        expect(new Set(events).size, `${label}: ${events.join(",")}`).toBe(3);
        expect(events, label).toHaveLength(3);
        expect(await deliveries(webhook), label).toHaveLength(3);
      }
      expect(arrivals("queued-c")).toHaveLength(0);
      expect(await deliveries(c)).toHaveLength(0);
    } finally {
      for (const id of [a, b, c]) await end(id);
    }
  });
});
