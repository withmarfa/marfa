import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect, type Socket } from "node:net";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { RowOperation, TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  trackWebhook,
  cleanup,
} from "../../utils/setup.js";
import type { SseEvent } from "../../utils/sse.js";
import { tapStream } from "../../utils/stream-tap.js";
import { startReceiver, type Receiver } from "../../utils/webhook-receiver.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;
let receiver: Receiver;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "table-rows-events",
  ));
  receiver = await startReceiver();
});

afterAll(async () => {
  await cleanup(ctx);
  await receiver.close();
});

let counter = 0;

async function tableType(columns: Record<string, unknown> = {}): Promise<string> {
  counter += 1;
  const type = `user.rows-events-${counter}-${ctx.runId}`;
  const made = await client.registerType({
    id: type,
    fields: { title: { type: "string" } },
    tables: {
      steps: {
        columns: { count: { type: "integer" }, note: { type: "string" }, ...columns },
      },
    },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return type;
}

async function itemOf(type: string): Promise<string> {
  const made = await client.createItem({ type, properties: { title: "Steps" } } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackItem(ctx, made.data.item.id);
  return made.data.item.id;
}

async function keyFor(types: Record<string, string>): Promise<string> {
  counter += 1;
  const made = await client.createKey({
    label: `rows-events-${counter}`,
    source: `${ctx.source}-k${counter}`,
    type_permissions: types,
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackKey(ctx, made.data.id);
  return made.data.key;
}

const rowsFor =
  (item: string) =>
  (event: SseEvent): boolean =>
    event.event === "rows.changed" &&
    (event.data as { item?: { id?: string } }).item?.id === item;

interface RowsFrame {
  event_type: string;
  item: { id: string; type: string; source: string };
  table: string;
  batch: string;
  last_activity_at: string;
  values_included?: boolean;
  rows: { id: string; values?: Record<string, unknown>; updated_at?: string; deleted?: boolean; withheld?: string[] }[];
}

describe("announcing rows", () => {
  it("announces one rows.changed per batch to a stream and a webhook", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const hook = await client.createWebhook({ url: receiver.hookUrl(`rows-${counter}`), events: ["rows.changed"] });
    expect(hook.status, JSON.stringify(hook.error)).toBe(201);
    trackWebhook(ctx, hook.data.id, client);
    const stranger = await tapStream(apiUrl, await keyFor({ "core.note": "read" }));
    const tap = await tapStream(apiUrl, apiKey);
    try {
      await tap.until((seen) => seen.some((e) => e.event === "stream_live"), "the stream going live");
      const gone = uuidv7();
      await client.writeRows(item, "steps", { operations: [{ op: "put", id: gone, values: { count: 1 } }] });
      const written = await client.writeRows(item, "steps", {
        operations: [
          { op: "put", values: { count: 2 } },
          { op: "patch", id: gone, values: { note: "seen" } },
          { op: "delete", id: gone },
        ],
      });
      expect(written.status, JSON.stringify(written.error)).toBe(200);
      const events = await tap.until(
        (seen) => seen.filter(rowsFor(item)).length >= 2,
        "two rows.changed frames",
      );
      const frames = events.filter(rowsFor(item));
      expect(frames).toHaveLength(2);
      const frame = frames[1]!.data as RowsFrame;
      expect(frame).toMatchObject({
        event_type: "rows.changed",
        item: { id: item, type, source: ctx.source },
        table: "steps",
        batch: written.data.batch,
        last_activity_at: written.data.last_activity_at,
      });
      expect(frame.rows).toEqual([
        { id: written.data.results[0]!.id, values: { count: 2 }, updated_at: written.data.last_activity_at },
        { id: gone, deleted: true },
      ]);
      const delivered = await receiver.waitFor(
        (r) => r.body.includes(written.data.batch!) && r.headers["x-marfa-event-type"] === "rows.changed",
      );
      expect(JSON.parse(delivered.body)).toMatchObject({ event_type: "rows.changed", batch: written.data.batch });

      const note = await client.createItem({ type: "core.note", properties: { title: "witness" } } as never);
      trackItem(ctx, note.data.item.id);
      const seen = await stranger.until(
        (got) => got.some((e) => (e.data as { item?: { id?: string } }).item?.id === note.data.item.id),
        "the witness note on the narrow stream",
      );
      expect(seen.filter((e) => e.event === "rows.changed")).toEqual([]);
    } finally {
      await tap.close();
      await stranger.close();
    }
  });

  it("announces nothing for a batch that changes nothing", async () => {
    const item = await itemOf(await tableType());
    const id = uuidv7();
    const tap = await tapStream(apiUrl, apiKey);
    try {
      await tap.until((seen) => seen.some((e) => e.event === "stream_live"), "the stream going live");
      const batch = { operations: [{ op: "put", id, values: { count: 1 } }] as RowOperation[] };
      await client.writeRows(item, "steps", batch);
      await client.writeRows(item, "steps", batch);
      await client.writeRows(item, "steps", { operations: [{ op: "delete", id: uuidv7() }] });
      const witness = await client.writeRows(item, "steps", { operations: [{ op: "put", values: { count: 9 } }] });
      const events = await tap.until(
        (seen) => seen.some((e) => rowsFor(item)(e) && (e.data as RowsFrame).batch === witness.data.batch),
        "the witness batch",
      );
      expect(events.filter(rowsFor(item))).toHaveLength(2);
    } finally {
      await tap.close();
    }
  });

  it("carries ids alone past the event's byte cap", async () => {
    const item = await itemOf(await tableType());
    const tap = await tapStream(apiUrl, apiKey);
    try {
      await tap.until((seen) => seen.some((e) => e.event === "stream_live"), "the stream going live");
      const operations: RowOperation[] = Array.from({ length: 5 }, () => ({
        op: "put",
        values: { note: "x".repeat(15_000) },
      }));
      const written = await client.writeRows(item, "steps", { operations });
      expect(written.status, JSON.stringify(written.error)).toBe(200);
      const events = await tap.until((seen) => seen.some(rowsFor(item)), "the rows.changed frame");
      const frame = events.find(rowsFor(item))!.data as RowsFrame;
      expect(frame.values_included).toBe(false);
      expect(frame.rows).toEqual(written.data.results.map((r) => ({ id: r.id })));

      const small = await client.writeRows(item, "steps", { operations: [{ op: "put", values: { count: 1 } }] });
      const after = await tap.until(
        (seen) => seen.some((e) => rowsFor(item)(e) && (e.data as RowsFrame).batch === small.data.batch),
        "the small batch",
      );
      const whole = after.find((e) => rowsFor(item)(e) && (e.data as RowsFrame).batch === small.data.batch)!.data as RowsFrame;
      expect(whole).not.toHaveProperty("values_included");
      expect(whole.rows[0]?.values).toEqual({ count: 1 });
    } finally {
      await tap.close();
    }
  });

  it("sends rows.changed only where a type filter selects the item", async () => {
    const chosen = await tableType();
    const other = await tableType();
    const chosenItem = await itemOf(chosen);
    const otherItem = await itemOf(other);
    const hook = await client.createWebhook({
      url: receiver.hookUrl(`filtered-${counter}`),
      events: ["rows.changed"],
      type_filter: chosen,
    });
    expect(hook.status, JSON.stringify(hook.error)).toBe(201);
    trackWebhook(ctx, hook.data.id, client);
    const tap = await tapStream(apiUrl, apiKey, { query: [["type", chosen]] });
    try {
      await tap.until((seen) => seen.some((e) => e.event === "stream_live"), "the stream going live");
      const skipped = await client.writeRows(otherItem, "steps", { operations: [{ op: "put", values: { count: 1 } }] });
      const sent = await client.writeRows(chosenItem, "steps", { operations: [{ op: "put", values: { count: 2 } }] });
      const events = await tap.until((seen) => seen.some(rowsFor(chosenItem)), "the chosen item's frame");
      expect(events.filter(rowsFor(otherItem))).toEqual([]);
      await receiver.waitFor((r) => r.body.includes(sent.data.batch!));
      expect(receiver.received.filter((r) => r.path.endsWith(`filtered-${counter}`) && r.body.includes(skipped.data.batch!))).toEqual([]);
    } finally {
      await tap.close();
    }
  });

  it("withholds an item column's id from a stream that may not read the item", async () => {
    counter += 1;
    const hiddenType = `user.rows-events-hidden-${counter}-${ctx.runId}`;
    expect((await client.registerType({ id: hiddenType, fields: { title: { type: "string" } } } as never)).status).toBe(201);
    const hidden = await itemOf(hiddenType);
    const type = await tableType({ about: { type: "item" } });
    const item = await itemOf(type);
    const narrow = await tapStream(apiUrl, await keyFor({ [type]: "read" }));
    const full = await tapStream(apiUrl, apiKey);
    try {
      await narrow.until((seen) => seen.some((e) => e.event === "stream_live"), "the narrow stream going live");
      await full.until((seen) => seen.some((e) => e.event === "stream_live"), "the full stream going live");
      const written = await client.writeRows(item, "steps", {
        operations: [{ op: "put", values: { count: 1, about: hidden } }],
      });
      expect(written.status, JSON.stringify(written.error)).toBe(200);
      const shown = (await narrow.until((seen) => seen.some(rowsFor(item)), "the narrow frame")).find(rowsFor(item))!.data as RowsFrame;
      expect(shown.rows[0]).toMatchObject({ values: { count: 1 }, withheld: ["about"] });
      expect(shown.rows[0]?.values).not.toHaveProperty("about");
      const whole = (await full.until((seen) => seen.some(rowsFor(item)), "the full frame")).find(rowsFor(item))!.data as RowsFrame;
      expect(whole.rows[0]?.values).toEqual({ count: 1, about: hidden });
      expect(whole.rows[0]).not.toHaveProperty("withheld");
      expect(JSON.stringify(whole)).not.toContain("item_types");
    } finally {
      await narrow.close();
      await full.close();
    }
  });

  it("keeps writing rows while a stream reader has stopped reading", async () => {
    const item = await itemOf(await tableType());
    const url = new URL(apiUrl);
    const socket: Socket = connect({ host: url.hostname, port: Number(url.port || 80) });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.on("error", () => {});
    socket.pause();
    socket.write(
      `GET ${url.pathname.replace(/\/$/, "")}/events HTTP/1.1\r\nHost: ${url.host}\r\n` +
        `Authorization: Bearer ${apiKey}\r\nAccept: text/event-stream\r\n\r\n`,
    );
    try {
      const operations: RowOperation[] = Array.from({ length: 20 }, () => ({
        op: "put",
        values: { note: "y".repeat(3_000) },
      }));
      for (let n = 0; n < 60; n++) {
        const started = Date.now();
        const res = await client.writeRows(item, "steps", { operations });
        expect(res.status, JSON.stringify(res.error)).toBe(200);
        expect(Date.now() - started).toBeLessThan(5_000);
      }
      const tables = await client.listTables(item);
      expect(tables.data.data[0]?.row_count).toBe(1200);
    } finally {
      socket.destroy();
    }
  });
});
