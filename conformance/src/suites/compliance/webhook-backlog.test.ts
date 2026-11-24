import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { WebhookDelivery } from "../../client/types.js";
import { controlRequest } from "../../utils/control-request.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { DAY_MS, MINUTE_MS, movedClock } from "../../utils/moved-clock.js";
import { waitFor } from "../../utils/wait.js";

const LIMIT = 3;
const REASON =
  "Adding this delivery would exceed the subscription's pending delivery or payload byte limit.";
/** The waits between the eight attempts of `events/retry-schedule`, in seconds. */
const WAITS_S = [1, 5, 25, 125, 625, 3125, 15625];

let server: FreshServer;
let clock: ReturnType<typeof movedClock>;
let hook: Hook;
let failing: Failing;
let webhookId: string;
/** Subscriptions to a receiver that fails every attempt at once: repointed, turned off and deleted. */
let others: string[] = [];

interface Hook {
  url: string;
  bodies: string[];
  recover(): void;
  hold(): void;
  close(): Promise<void>;
}

interface Failing {
  url(path: string): string;
  close(): Promise<void>;
}

async function startFailing(): Promise<Failing> {
  const receiver = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(503);
      res.end("unavailable");
    });
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, "127.0.0.1", resolve),
  );
  const address = receiver.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("the failing receiver did not bind to a port");
  }
  return {
    url: (path) => `http://127.0.0.1:${String(address.port)}/${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        receiver.closeAllConnections();
        receiver.close(() => resolve());
      }),
  };
}

async function startHook(): Promise<Hook> {
  const bodies: string[] = [];
  const held: ServerResponse[] = [];
  const sockets = new Set<Socket>();
  let answering = false;
  const answer = (res: ServerResponse) => {
    res.writeHead(200);
    res.end("ok");
  };
  const receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      bodies.push(body);
      if (answering) answer(res);
      else held.push(res);
    });
  });
  receiver.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) =>
    receiver.listen(0, "127.0.0.1", resolve),
  );
  const address = receiver.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("the receiver did not bind to a port");
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}/hook`,
    bodies,
    recover() {
      answering = true;
      for (const res of held.splice(0)) {
        if (!res.writableEnded && !res.destroyed) answer(res);
      }
    },
    hold() {
      answering = false;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    },
  };
}

beforeAll(async () => {
  server = await bootFreshServer("webhook-backlog", {
    MARFA_WEBHOOK_BACKLOG_DELIVERIES: String(LIMIT),
  });
  clock = movedClock(server);
  await clock.pause();
  hook = await startHook();
  failing = await startFailing();
  webhookId = await subscribe(hook.url);
  others = [
    await subscribe(failing.url("repointed")),
    await subscribe(failing.url("turned-off")),
    await subscribe(failing.url("deleted")),
  ];
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await hook?.close();
  await failing?.close();
  await stopFreshServers();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function writer(): MarfaClient {
  return new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.workingKey });
}

async function subscribe(url: string): Promise<string> {
  const created = await writer().createWebhook({
    url,
    events: ["item.created"],
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  return created.data.id;
}

async function configure(changes: Record<string, number>): Promise<void> {
  const patched = await new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  }).patchConfig(changes);
  expect(patched.status, JSON.stringify(patched.error)).toBe(200);
}

async function write(body: string): Promise<string> {
  const note = await writer().createItem({
    type: "core.note",
    properties: { body },
  });
  expect(note.ok, JSON.stringify(note.error)).toBe(true);
  return note.data.item.id;
}

async function deliveries(id = webhookId): Promise<WebhookDelivery[]> {
  const listed = await writer().listWebhookDeliveries(id, {
    limit: 100,
  });
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  return listed.data.data;
}

// Scheduling continues after the item write returns.
const recorded = (count: number) =>
  waitFor(`${String(count)} deliveries to be recorded`, async () => {
    const rows = await deliveries();
    return rows.length >= count ? rows : undefined;
  });

const withStatus = (rows: WebhookDelivery[], status: string) =>
  rows.filter((row) => row.status === status);

async function attentionEntries(): Promise<
  { kind: string; reference: string }[]
> {
  const answer = await controlRequest(server.controlSocket, "/attention");
  expect(answer.status).toBe(200);
  return (answer.body as { data: { kind: string; reference: string }[] }).data;
}

const listedInAttention = async (id = webhookId) =>
  (await attentionEntries()).some(
    (entry) => entry.kind === "webhook" && entry.reference === id,
  );

/** The payload a delivery stores: the body it was sent with, less what each attempt adds. */
function storedBytes(body: string): number {
  const {
    event_id: _event,
    delivery_id: _delivery,
    delivered_at: _at,
    ...payload
  } = JSON.parse(body) as Record<string, unknown>;
  return Buffer.byteLength(JSON.stringify(payload));
}

describe("a webhook whose receiver never answers", () => {
  const unsent: string[] = [];

  // Each case builds on the last one's deliveries and moved clock, so none runs twice.
  it(
    "records a delivery past a subscription's pending limit as canceled, with the reason",
    { retry: 0 },
    async () => {
      for (let n = 0; n < LIMIT; n += 1) await write(`queued ${String(n)}`);
      await waitFor("the first attempt to reach the receiver", async () =>
        hook.bodies.length > 0 ? true : undefined,
      );
      for (let n = 0; n < 2; n += 1)
        unsent.push(await write(`past ${String(n)}`));
      const rows = await recorded(LIMIT + 2);
      expect(withStatus(rows, "pending")).toHaveLength(LIMIT);
      const canceled = withStatus(rows, "canceled");
      expect(canceled).toHaveLength(2);
      for (const row of canceled) {
        expect(row.error).toBe(REASON);
        expect(row.attempt).toBe(0);
      }
    },
  );

  it(
    "keeps the pending deliveries a lowered limit leaves over it, across a restart",
    { retry: 0, timeout: FRESH_SERVER_TIMEOUT_MS },
    async () => {
      await configure({ webhook_backlog_deliveries: 1 });
      await server.restart();
      await clock.pause();
      unsent.push(await write("past a lowered limit"));
      const rows = await recorded(LIMIT + 3);
      expect(withStatus(rows, "pending")).toHaveLength(LIMIT);
      expect(withStatus(rows, "canceled")).toHaveLength(3);
    },
  );

  it(
    "goes on attempting the pending deliveries a lowered limit leaves over it",
    { retry: 0, timeout: 120_000 },
    async () => {
      await waitFor(
        "an attempt after the restart to end unanswered",
        async () =>
          (await deliveries()).some(
            (row) => row.status === "pending" && row.attempt >= 1,
          )
            ? true
            : undefined,
        45_000,
      );
      // Past the first wait, still far short of the day attention waits for.
      await clock.advance(2_000);
      await waitFor(
        "a second attempt while the lowered limit applies",
        async () =>
          (await deliveries()).some(
            (row) => row.status === "pending" && row.attempt >= 2,
          )
            ? true
            : undefined,
        90_000,
      );
      expect(withStatus(await deliveries(), "pending")).toHaveLength(LIMIT);
      await configure({ webhook_backlog_deliveries: LIMIT });
    },
  );

  it(
    "lists a webhook in attention once every recorded attempt has failed for a day",
    { retry: 0, timeout: 60_000 },
    async () => {
      for (const id of others) {
        await waitFor(`a failed attempt to ${id}`, async () =>
          (await deliveries(id)).some((row) => row.attempt >= 1)
            ? true
            : undefined,
        );
      }
      await clock.advance(DAY_MS - 10 * MINUTE_MS);
      expect(await listedInAttention(), "short of a day").toBe(false);
      await clock.advance(20 * MINUTE_MS);
      expect(await listedInAttention(), "past a day").toBe(true);
      for (const id of others) {
        expect(await listedInAttention(id), `${id} past a day`).toBe(true);
      }
    },
  );

  it(
    "clears a listed webhook from attention when it is pointed at another URL, turned off or deleted",
    { retry: 0 },
    async () => {
      const [repointed, turnedOff, deleted] = others as [
        string,
        string,
        string,
      ];
      const moved = await writer().updateWebhook(repointed, {
        url: failing.url("elsewhere"),
      });
      expect(moved.status, JSON.stringify(moved.error)).toBe(200);
      expect(await listedInAttention(repointed), "repointed").toBe(false);
      expect(
        await listedInAttention(turnedOff),
        "before it is turned off",
      ).toBe(true);

      const off = await writer().updateWebhook(turnedOff, { active: false });
      expect(off.status, JSON.stringify(off.error)).toBe(200);
      expect(await listedInAttention(turnedOff), "turned off").toBe(false);
      expect(await listedInAttention(deleted), "before it is deleted").toBe(
        true,
      );

      const gone = await writer().deleteWebhook(deleted);
      expect(gone.ok, JSON.stringify(gone.error)).toBe(true);
      expect(await listedInAttention(deleted), "deleted").toBe(false);
      expect(await listedInAttention(), "the webhook left as it was").toBe(
        true,
      );
    },
  );

  it(
    "drains the backlog once the receiver answers, clears the webhook from attention and queues the next delivery",
    { retry: 0, timeout: 120_000 },
    async () => {
      hook.recover();
      await waitFor(
        "the backlog to drain",
        async () =>
          withStatus(await deliveries(), "pending").length === 0
            ? true
            : undefined,
        60_000,
      );
      expect(withStatus(await deliveries(), "succeeded")).toHaveLength(LIMIT);
      expect(await listedInAttention(), "after a success").toBe(false);
      for (const id of unsent) {
        expect(
          hook.bodies.some((body) => body.includes(id)),
          `${id} was sent`,
        ).toBe(false);
      }

      const sent = await write("after the receiver recovered");
      await waitFor("a delivery after the backlog drained", async () =>
        hook.bodies.some((body) => body.includes(sent)) ? true : undefined,
      );
      expect(
        (await deliveries()).find((row) => row.status === "pending"),
      ).toBeUndefined();
    },
  );

  it(
    "records a delivery past a subscription's pending bytes as canceled, with the reason",
    { retry: 0, timeout: 60_000 },
    async () => {
      hook.hold();
      const held = await write("held for the bytes");
      const body = await waitFor(
        "the held delivery to reach the receiver",
        async () => hook.bodies.find((sent) => sent.includes(held)),
      );
      // The next payload fits alone, and not beside the one still pending.
      await configure({
        webhook_backlog_bytes: Math.floor(storedBytes(body) * 1.5),
      });
      const before = withStatus(await deliveries(), "canceled").length;
      const id = await write("past the bytes now");
      const canceled = await waitFor(
        "the delivery past the bytes",
        async () => {
          const rows = withStatus(await deliveries(), "canceled");
          return rows.length > before ? rows : undefined;
        },
      );
      expect(canceled).toHaveLength(before + 1);
      for (const row of canceled) {
        expect(row.error).toBe(REASON);
        expect(row.attempt).toBe(0);
      }
      expect(
        withStatus(await deliveries(), "pending"),
        "the held delivery stays pending",
      ).toHaveLength(1);

      hook.recover();
      await configure({ webhook_backlog_bytes: 64 * 1024 * 1024 });
      const sentinel = await write("after the bytes limit rose");
      await waitFor("the sentinel's delivery", async () =>
        hook.bodies.some((sent) => sent.includes(sentinel)) ? true : undefined,
      );
      expect(hook.bodies.some((sent) => sent.includes(id))).toBe(false);
    },
  );

  it(
    "refuses a redelivery past a subscription's pending limit with 409 backlog_full, keeping the delivery failed",
    { retry: 0, timeout: 120_000 },
    async () => {
      const doomed = await subscribe(failing.url("redelivered"));
      await write("given up on");
      const attempted = (n: number, status: string) =>
        waitFor(`attempt ${String(n)} to be recorded ${status}`, async () =>
          (await deliveries(doomed)).find(
            (row) => row.attempt === n && row.status === status,
          ),
        );
      for (const [index, wait] of WAITS_S.entries()) {
        await attempted(index + 1, "pending");
        await clock.advance(wait * 1000 + 1000);
      }
      const given = await attempted(8, "failed");
      await write("queued behind it");
      await waitFor("a second delivery pending", async () =>
        withStatus(await deliveries(doomed), "pending").length === 1
          ? true
          : undefined,
      );
      await configure({ webhook_backlog_deliveries: 1 });

      const redeliver = () =>
        writer().rawRequest<WebhookDelivery>(
          `/webhooks/${doomed}/deliveries/${given.id}/redeliver`,
          { method: "POST" },
        );
      const refused = await redeliver();
      expect(refused.status).toBe(409);
      expect(refused.error?.error.code).toBe("conflict");
      expect(refused.error?.error.details).toEqual({ reason: "backlog_full" });
      const kept = (await deliveries(doomed)).find(
        (row) => row.id === given.id,
      );
      expect(kept?.status).toBe("failed");
      expect(kept?.attempt).toBe(8);

      await configure({ webhook_backlog_deliveries: 2 });
      const accepted = await redeliver();
      expect(accepted.status, JSON.stringify(accepted.error)).toBe(202);
      expect(accepted.data.status).toBe("pending");
    },
  );
});
