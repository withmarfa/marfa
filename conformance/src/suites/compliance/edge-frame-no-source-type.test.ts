import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import type { SseEvent } from "../../utils/sse.js";
import {
  streamHead,
  tapStream,
  type StreamTap,
} from "../../utils/stream-tap.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";

/**
 * The declared edge-source-type fault withholds the type from one published
 * edge, in both its stored and live forms. No target files are accessed.
 */

let server: FreshServer;
let working: MarfaClient;
let receiver: Receiver;

beforeAll(async () => {
  server = await bootFreshServer("edge-frame-no-source-type");
  working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  receiver = await startReceiver();
}, FRESH_SERVER_TIMEOUT_MS);

const taps: StreamTap[] = [];
afterEach(async () => {
  await server.clearFault();
  await Promise.all(taps.splice(0).map((tap) => tap.close()));
});

afterAll(async () => {
  await receiver.close();
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

let serial = 0;
async function note(label: string): Promise<string> {
  serial += 1;
  const created = await working.createItem({
    type: "core.note",
    properties: { body: `${label}-${String(serial)}` },
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  return created.data.item.id;
}

async function edge(): Promise<string> {
  const created = await working.createEdge({
    source_id: await note("edge-source"),
    target_id: await note("edge-target"),
    edge_type: "about",
  });
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  return created.data.edge.id;
}

async function untypedEdge(): Promise<string> {
  await server.setFault("fail:edge-source-type");
  const id = await edge();
  expect(await server.faults()).toContainEqual(
    expect.objectContaining({
      name: "fail:edge-source-type",
      fired: 1,
    }),
  );
  await server.clearFault("fail:edge-source-type");
  return id;
}

const edgeOf = (event: SseEvent): string | undefined =>
  (event.data as { edge?: { id?: string } }).edge?.id;

describe("an edge event that carries no source type", () => {
  it("is not replayed to a subscriber", async () => {
    const before = await streamHead(server.apiUrl, server.workingKey);
    const untyped = await untypedEdge();
    const typed = await edge();

    const tap = await tapStream(server.apiUrl, server.workingKey, {
      lastEventId: before,
    });
    taps.push(tap);
    const events = await tap.until(
      (seen) => seen.some((event) => event.event === "stream_live"),
      "the replay done",
    );
    // The witness: the replay sends an edge event that does carry its type.
    expect(events.some((event) => edgeOf(event) === typed)).toBe(true);
    expect(events.some((event) => edgeOf(event) === untyped)).toBe(false);
  });

  it("is not sent to a live subscriber", async () => {
    const tap = await tapStream(server.apiUrl, server.workingKey);
    taps.push(tap);
    await tap.until(
      (seen) => seen.some((event) => event.event === "stream_live"),
      "the subscriber live before the writes",
    );
    const untyped = await untypedEdge();
    const typed = await edge();
    const events = await tap.until(
      (seen) => seen.some((event) => edgeOf(event) === typed),
      "the typed edge after the untyped edge",
    );
    expect(events.some((event) => edgeOf(event) === untyped)).toBe(false);
  });

  it("is sent to no webhook", async () => {
    const hook = await working.createWebhook({
      url: receiver.hookUrl("no-source-type"),
      events: ["edge.created"],
    });
    expect(hook.ok, JSON.stringify(hook.error)).toBe(true);

    await server.setFault("hold:housekeeping:webhook-schedule");
    await server.waitForHold("hold:housekeeping:webhook-schedule");
    const untyped = await untypedEdge();
    const typed = await edge();
    await server.clearFault("hold:housekeeping:webhook-schedule");

    // The witness: the job ran over both rows and delivered the one it could
    // classify.
    await receiver.waitFor((received) => received.body.includes(typed));
    expect(
      receiver.received.some((received) => received.body.includes(untyped)),
      "the webhook was sent an edge event with no source type",
    ).toBe(false);
    const deliveries = await working.listWebhookDeliveries(hook.data.id, {
      limit: 100,
    });
    expect(deliveries.ok).toBe(true);
    expect(JSON.stringify(deliveries.data)).not.toContain(untyped);
  });
});
