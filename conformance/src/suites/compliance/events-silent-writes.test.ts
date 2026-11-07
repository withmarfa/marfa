import { afterAll, beforeAll, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { createNote } from "../../generators/items.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";

// A server of its own: the assertion is that the stream carries nothing but
// the witness, which another file's write would break on the shared server.
let server: FreshServer;
let receiver: Receiver;
let working: MarfaClient;
let management: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("events-silent-writes");
  receiver = await startReceiver();
  working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
  management = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.managementKey,
  });
}, 2 * FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await receiver?.close();
  await server?.stop();
}, 2 * FRESH_SERVER_TIMEOUT_MS);

it("sends nothing for a write to a type, an edge type, a key, the configuration or a webhook, and sends the item write after them", async ({
  signal,
}) => {
  const ok = (r: { status: number; error?: unknown }, expected: number) => {
    expect(r.status, JSON.stringify(r.error)).toBe(expected);
  };
  const fields = { name: { type: "string" } };

  const frames = await withStream(
    server.apiUrl,
    server.workingKey,
    {},
    async (stream) => {
      await new Promise((r) => setTimeout(r, 250));

      ok(
        await working.registerType({ id: "silent.thing", fields } as never),
        201,
      );
      ok(
        await working.replaceType("silent.thing", {
          id: "silent.thing",
          fields: { ...fields, size: { type: "number" } },
        }),
        200,
      );
      ok(await working.deleteType("silent.thing"), 200);

      ok(
        await working.registerEdgeType({
          id: "silent-link",
          cardinality: "many-to-many",
        } as never),
        201,
      );
      ok(await working.deleteEdgeType("silent-link"), 200);

      const key = await management.createKey({
        label: "silent",
        source: "silent-key",
        permissions: ["audit.read"],
      });
      ok(key, 201);
      ok(
        await management.updateKey(key.data.id, { label: "silent again" }),
        200,
      );
      ok(await management.revokeKey(key.data.id), 200);

      ok(
        await management.updateConfig({
          enforcement: {
            source_filter: { types: ["core.task"], sources: ["silent"] },
          },
        }),
        200,
      );

      const hook = await working.createWebhook({
        url: receiver.hookUrl("silent"),
        events: ["item.created"],
      });
      ok(hook, 201);
      ok(await working.updateWebhook(hook.data.id, { active: false }), 200);
      ok(await working.deleteWebhook(hook.data.id), 200);

      const witness = await working.createItem(createNote());
      ok(witness, 201);
      const { events } = await collectUntil(
        stream,
        (evts) =>
          evts.some(
            (e) =>
              (e.data as { item?: { id?: string } }).item?.id ===
              witness.data.item.id,
          ),
        `the witness ${witness.data.item.id}`,
        signal,
      );
      return { events, witness: witness.data.item.id };
    },
  );

  const sent = frames.events.filter((e) => !e.event.startsWith("stream_"));
  expect(sent.map((e) => e.event)).toEqual(["item.created"]);
  expect((sent[0]?.data as { item: { id: string } }).item.id).toBe(
    frames.witness,
  );
});
