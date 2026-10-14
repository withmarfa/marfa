import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  stopFreshServers,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";
import { waitFor } from "../../utils/wait.js";

let server: FreshServer;
let receiver: Receiver;

beforeAll(async () => {
  server = await bootFreshServer("webhook-bulk-backlog");
  receiver = await startReceiver();
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await receiver?.close();
  await stopFreshServers();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

it("delivers the next fan-out within ordinary latency after 50,000 bulk rows", async () => {
  const client = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  const subscription = await client.createWebhook({
    url: receiver.hookUrl("backlog"),
    events: ["item.created"],
  });
  expect(subscription.ok, JSON.stringify(subscription.error)).toBe(true);
  const write = async (body: string) => {
    const answer = await client.createItem({
      type: "core.note",
      properties: { body },
    });
    expect(answer.ok, JSON.stringify(answer.error)).toBe(true);
    return answer.data.item.id;
  };
  const delivered = async (id: string) =>
    waitFor(
      `webhook for ${id}`,
      async () => receiver.received.find((row) => row.body.includes(id)),
      5_000,
    );
  const witness = await write("ordinary latency witness");
  await delivered(witness);
  for (let from = 0; from < 50_000; from += 5_000) {
    const answer = await client.bulkItems({
      items: Array.from({ length: 5_000 }, (_, n) => ({
        type: "core.note",
        properties: { body: `bulk ${String(from + n)}` },
      })),
    });
    expect(answer.ok, JSON.stringify(answer.error)).toBe(true);
    expect(answer.data.counts.created).toBe(5_000);
  }
  const started = performance.now();
  const sentinel = await write("fan-out after 50,000 bulk rows");
  await delivered(sentinel);
  const elapsed = performance.now() - started;
  expect(elapsed).toBeLessThan(5_000);
  expect(receiver.received).toHaveLength(2);
  console.log(
    `50,000 bulk rows: next fan-out delivered in ${String(Math.round(elapsed))} ms`,
  );
}, 300_000);
