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
  "The subscription held as many pending deliveries, or bytes, as the instance allows.";

let server: FreshServer;
let clock: ReturnType<typeof movedClock>;
let hook: Hook;
let webhookId: string;

interface Hook {
  url: string;
  bodies: string[];
  recover(): void;
  close(): Promise<void>;
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
  const created = await writer().createWebhook({
    url: hook.url,
    events: ["item.created"],
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  webhookId = created.data.id;
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await hook?.close();
  await stopFreshServers();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function writer(): MarfaClient {
  return new MarfaClient({ baseUrl: server.apiUrl, apiKey: server.workingKey });
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

async function deliveries(): Promise<WebhookDelivery[]> {
  const listed = await writer().listWebhookDeliveries(webhookId, {
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

const listedInAttention = async () =>
  (await attentionEntries()).some(
    (entry) => entry.kind === "webhook" && entry.reference === webhookId,
  );

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
      await configure({ webhook_backlog_deliveries: LIMIT });
    },
  );

  it(
    "lists a webhook in attention once every attempt has failed for a day, and clears it once one succeeds",
    { retry: 0, timeout: 120_000 },
    async () => {
      await waitFor(
        "the held attempt to end unanswered",
        async () =>
          (await deliveries()).some(
            (row) => row.status === "pending" && row.attempt === 1,
          )
            ? true
            : undefined,
        30_000,
      );
      await clock.advance(DAY_MS - 10 * MINUTE_MS);
      expect(await listedInAttention(), "short of a day").toBe(false);
      await clock.advance(20 * MINUTE_MS);
      expect(await listedInAttention(), "past a day").toBe(true);

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
    },
  );

  it(
    "records a delivery past a subscription's pending bytes as canceled, with the reason",
    { retry: 0 },
    async () => {
      await configure({ webhook_backlog_bytes: 1 });
      const earlier = await deliveries();
      const before = withStatus(earlier, "canceled").length;
      const id = await write("past the bytes");
      const rows = await recorded(earlier.length + 1);
      expect(withStatus(rows, "canceled")).toHaveLength(before + 1);
      expect(withStatus(rows, "pending")).toHaveLength(0);
      expect(rows.filter((row) => row.error === REASON)).toHaveLength(
        before + 1,
      );
      await configure({ webhook_backlog_bytes: 64 * 1024 * 1024 });
      const sentinel = await write("after the bytes limit rose");
      await waitFor("the sentinel's delivery", async () =>
        hook.bodies.some((body) => body.includes(sentinel)) ? true : undefined,
      );
      expect(hook.bodies.some((body) => body.includes(id))).toBe(false);
    },
  );
});
