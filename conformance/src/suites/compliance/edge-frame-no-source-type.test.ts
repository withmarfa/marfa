import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
 * An edge event whose stored form names no source type cannot be shown
 * readable to anyone, so it is sent to no subscriber and no webhook
 * (`events/edge-frame-no-source-type`).
 *
 * No request writes such an event, so the fixture removes the field from the
 * stored row of an edge it created, as the stored rows of
 * `stream-unreadable-rows` are damaged. The stream is opened after the damage
 * so that no live copy, which carries the type, stands in for the row; the
 * webhook job is held (`hold:housekeeping:webhook-schedule`) so that it reads
 * the row only after the damage.
 */

const runSqlite = promisify(execFile);

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

async function removeSourceType(edgeId: string): Promise<void> {
  await runSqlite("sqlite3", [
    "-cmd",
    ".timeout 10000",
    server.sqlitePath,
    `UPDATE event_log SET payload = json_remove(payload, '$.source_type') WHERE edge_id = '${edgeId}' AND event_type = 'edge_created';`,
  ]);
  const check = await runSqlite("sqlite3", [
    server.sqlitePath,
    `SELECT count(*) FROM event_log WHERE edge_id = '${edgeId}' AND json_extract(payload, '$.source_type') IS NULL;`,
  ]);
  expect(Number(check.stdout.trim()), "the field was not removed").toBe(1);
}

const edgeOf = (event: SseEvent): string | undefined =>
  (event.data as { edge?: { id?: string } }).edge?.id;

describe("an edge event that carries no source type", () => {
  it("is not replayed to a subscriber", async () => {
    const before = await streamHead(server.apiUrl, server.workingKey);
    const untyped = await edge();
    const typed = await edge();
    await removeSourceType(untyped);

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

  it("is sent to no webhook", async () => {
    const hook = await working.createWebhook({
      url: receiver.hookUrl("no-source-type"),
      events: ["edge.created"],
    });
    expect(hook.ok, JSON.stringify(hook.error)).toBe(true);

    await server.setFault("hold:housekeeping:webhook-schedule");
    await server.waitForHold("hold:housekeeping:webhook-schedule");
    const untyped = await edge();
    const typed = await edge();
    await removeSourceType(untyped);
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
