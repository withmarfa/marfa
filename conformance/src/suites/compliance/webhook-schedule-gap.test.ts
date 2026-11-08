import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { streamHead } from "../../utils/stream-tap.js";
import { waitFor } from "../../utils/wait.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";

/**
 * The server keeps its place in the event log as it queues webhook
 * deliveries, and a place the log cannot account for is one it must report,
 * rather than skip what lies between.
 *
 * A server of its own: no door moves the place or removes an event, so a
 * fault makes the server read an event, or the place, as absent. A fault
 * changes nothing the server is woken by, so the fixture moves the server's
 * clock by a millisecond after it arms or clears one.
 */
let server: FreshServer | undefined;
let receiver: Receiver;
let webhookId: string;

beforeAll(async () => {
  server = await bootFreshServer("webhook-schedule-gap");
  receiver = await startReceiver();
  const created = await client().createWebhook({
    url: receiver.hookUrl("gap"),
    events: ["item.created"],
  });
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  webhookId = created.data.id;
  await write(3);
  await caughtUp();
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await receiver?.close();
  await stopFreshServers();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

function client(): MarfaClient {
  return new MarfaClient({
    baseUrl: server!.apiUrl,
    apiKey: server!.workingKey,
  });
}

const hidden = (first: bigint, last: bigint = first) =>
  `hide:event=${first === last ? String(first) : `${String(first)}-${String(last)}`}`;

async function head(): Promise<bigint> {
  return BigInt(await streamHead(server!.apiUrl, server!.workingKey));
}

let written = 0;

/** Writes `count` notes and checks each added one event to the log. */
async function write(count: number): Promise<void> {
  const before = await head();
  for (let n = 0; n < count; n += 1) {
    written += 1;
    const created = await client().createItem({
      type: "core.note",
      properties: { body: `schedule-gap-${String(written)}` },
    });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
  }
  expect(await head()).toBe(before + BigInt(count));
}

/** The event ids the receiver was sent, in order of arrival. */
const sent = (): string[] =>
  receiver.received.map(
    (r) => (JSON.parse(r.body) as { event_id: string }).event_id,
  );

async function queued(): Promise<number> {
  const listed = await client().listWebhookDeliveries(webhookId, {
    limit: 200,
  });
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  return listed.data.data.length;
}

/** Waits until every note written so far was delivered, each once. */
async function caughtUp(): Promise<void> {
  await waitFor(
    `all ${String(written)} notes to be delivered`,
    async () => (sent().length >= written ? true : undefined),
    30_000,
  );
  expect(new Set(sent()).size, sent().join(",")).toBe(written);
  expect(sent()).toHaveLength(written);
  expect(await queued()).toBe(written);
}

async function unhandled(): Promise<number> {
  return (await server!.output())
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as { message?: string })
    .filter((line) => line.message === "Unhandled error").length;
}

const wake = () => server!.advanceClock(1);

/**
 * Each gap is a fault armed from the log's head, `h`, once the server has
 * caught up with it, so its place is `h`, and the events written after it.
 */
const gaps: readonly {
  name: string;
  fault: (h: bigint) => string;
  writes: number;
}[] = [
  { name: "ahead of the log", fault: (h) => hidden(h), writes: 0 },
  {
    name: "at a hole in the retained events",
    fault: (h) => hidden(h + 1n),
    writes: 2,
  },
  {
    name: "behind the oldest event the log retains",
    fault: (h) => hidden(1n, h + 1n),
    writes: 2,
  },
  {
    name: "missing from a log that holds events",
    fault: () => "hide:webhook-position",
    writes: 2,
  },
];

describe("the place the server keeps in the event log for webhooks", () => {
  it("reports a place the log cannot account for as an unhandled fault, and queues nothing past it", async () => {
    for (const gap of gaps) {
      // The witness, before each gap: every event so far was queued and
      // sent, with no fault reported.
      const reported = await unhandled();
      const queuedBefore = await queued();
      expect(queuedBefore, `before the position was ${gap.name}`).toBe(written);

      const fault = gap.fault(await head());
      await server!.setFault(fault);
      await write(gap.writes);
      await wake();
      await waitFor(
        `a fault report with the position ${gap.name}`,
        async () => ((await unhandled()) > reported ? true : undefined),
        30_000,
      );
      expect(await queued(), `with the position ${gap.name}`).toBe(
        queuedBefore,
      );

      // Once the place is accounted for again, what was written behind the
      // gap is queued and sent, each event once.
      await server!.clearFault(fault.split("=")[0]);
      await wake();
      await caughtUp();
    }
  });
});
