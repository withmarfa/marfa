import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { TableRow, TestContext } from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import { expectMatchesSchema } from "../../utils/openapi.js";

/**
 * A row batch and an undo sent again under one `Idempotency-Key`
 * (`tables/rows-keyed`): answered from the record, never run twice.
 */

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "table-rows-keyed",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

let counter = 0;

async function ledger(): Promise<{ type: string; item: string }> {
  counter += 1;
  const type = `user.rows-keyed-${counter}-${ctx.runId}`;
  const made = await client.registerType({
    id: type,
    fields: { title: { type: "string" } },
    tables: {
      lines: {
        columns: { amount: { type: "number" }, memo: { type: "string" } },
      },
    },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  const created = await client.createItem({
    type,
    properties: { title: "Ledger" },
  } as never);
  expect(created.status, JSON.stringify(created.error)).toBe(201);
  trackItem(ctx, created.data.item.id);
  return { type, item: created.data.item.id };
}

interface Writer {
  id: string;
  client: MarfaClient;
}

async function writer(type: string): Promise<Writer> {
  counter += 1;
  const made = await client.createKey({
    label: `rows-keyed-${counter}`,
    source: `${ctx.source}-k${counter}`,
    type_permissions: { [type]: "write" },
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackKey(ctx, made.data.id);
  return {
    id: made.data.id,
    client: new MarfaClient({ baseUrl: apiUrl, apiKey: made.data.key }),
  };
}

type Answer = Awaited<ReturnType<MarfaClient["rawRequest"]>>;

function keyed(
  by: Writer,
  path: string,
  body?: unknown,
): () => Promise<Answer> {
  const headers = { "Idempotency-Key": `rows-${randomUUID()}` };
  return () =>
    by.client.rawRequest<unknown>(path, {
      method: "POST",
      headers,
      ...(body === undefined ? {} : { body: body as Record<string, unknown> }),
    });
}

async function values(item: string): Promise<Record<string, unknown>> {
  const listed = await client.listRows(item, "lines", { limit: 1000 });
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  return Object.fromEntries(
    listed.data.data.map((row: TableRow) => [row.id, row.values]),
  );
}

async function batches(item: string): Promise<number> {
  const listed = await client.rawRequest<{ data: unknown[] }>(
    `/items/${item}/tables/lines/batches?limit=1000`,
  );
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  await expectMatchesSchema(
    "GET",
    "/items/{id}/tables/{table}/batches",
    200,
    listed.data,
  );
  return listed.data.data.length;
}

function expectReplay(answer: Answer, first: Answer): void {
  expect(answer.status, JSON.stringify(answer.error)).toBe(first.status);
  expect(answer.headers.get("Idempotency-Replayed")).toBe("true");
  expect(answer.data).toEqual(first.data);
}

describe("row writes under an Idempotency-Key", () => {
  it("answers a batch sent again under its key from the record, keeping a change made between the two", async () => {
    const { type, item } = await ledger();
    const row = uuidv7();
    const made = await client.writeRows(item, "lines", {
      operations: [{ op: "put", id: row, values: { amount: 1, memo: "a" } }],
    });
    expect(made.status, JSON.stringify(made.error)).toBe(200);
    const actor = await writer(type);
    const send = keyed(actor, `/items/${item}/tables/lines/rows`, {
      operations: [{ op: "patch", id: row, values: { memo: "first" } }],
    });
    const first = await send();
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    expect(first.headers.get("Idempotency-Replayed")).toBeNull();
    const between = await client.writeRows(item, "lines", {
      operations: [{ op: "patch", id: row, values: { memo: "between" } }],
    });
    expect(between.status, JSON.stringify(between.error)).toBe(200);
    const logged = await batches(item);

    expectReplay(await send(), first);
    expect(await values(item)).toEqual({
      [row]: { amount: 1, memo: "between" },
    });
    expect(await batches(item), "the repeat logged a batch").toBe(logged);

    const narrowed = await client.updateKey(actor.id, {
      type_permissions: { [type]: "read" },
    });
    expect(narrowed.ok, JSON.stringify(narrowed.error)).toBe(true);
    const refused = await send();
    expect(refused.status).toBe(403);
    expect(refused.error?.error.code).toBe("type_not_permitted");
    expect(refused.headers.get("Idempotency-Replayed")).toBeNull();
  });

  it("answers an undo sent again under its key from the record, undoing once", async () => {
    const { type, item } = await ledger();
    const row = uuidv7();
    const made = await client.writeRows(item, "lines", {
      operations: [{ op: "put", id: row, values: { amount: 1 } }],
    });
    expect(made.status, JSON.stringify(made.error)).toBe(200);
    const changed = await client.writeRows(item, "lines", {
      operations: [{ op: "patch", id: row, values: { amount: 2 } }],
    });
    expect(changed.status, JSON.stringify(changed.error)).toBe(200);
    const actor = await writer(type);
    const send = keyed(
      actor,
      `/items/${item}/tables/lines/batches/${changed.data.batch!}/undo`,
    );
    const first = await send();
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    await expectMatchesSchema(
      "POST",
      "/items/{id}/tables/{table}/batches/{batch}/undo",
      200,
      first.data,
    );
    expect(await values(item)).toEqual({ [row]: { amount: 1 } });
    const logged = await batches(item);

    expectReplay(await send(), first);
    expect(await values(item)).toEqual({ [row]: { amount: 1 } });
    expect(await batches(item), "the repeat undid the batch again").toBe(
      logged,
    );
  });

  it("answers a put, a patch and a delete sent again under their key from the record, writing each once", async () => {
    const { type, item } = await ledger();
    const actor = await writer(type);
    const kept = uuidv7();
    const gone = uuidv7();
    const seeded = await client.writeRows(item, "lines", {
      operations: [
        { op: "put", id: kept, values: { amount: 1, memo: "a" } },
        { op: "put", id: gone, values: { amount: 2 } },
      ],
    });
    expect(seeded.status, JSON.stringify(seeded.error)).toBe(200);
    const made = uuidv7();
    const doors: [string, Record<string, unknown>][] = [
      ["put", { op: "put", id: made, values: { amount: 3, memo: "new" } }],
      ["patch", { op: "patch", id: kept, values: { memo: "patched" } }],
      ["delete", { op: "delete", id: gone }],
    ];
    for (const [door, operation] of doors) {
      const send = keyed(actor, `/items/${item}/tables/lines/rows`, {
        operations: [operation],
      });
      const first = await send();
      expect(first.status, `${door}: ${JSON.stringify(first.error)}`).toBe(200);
      expect(first.headers.get("Idempotency-Replayed")).toBeNull();
      const logged = await batches(item);
      const held = await values(item);
      for (let again = 0; again < 2; again += 1) {
        const replay = await send();
        expectReplay(replay, first);
        expect(await batches(item), `a repeated ${door} logged a batch`).toBe(
          logged,
        );
        expect(await values(item), `a repeated ${door} changed a row`).toEqual(
          held,
        );
      }
    }
    expect(await values(item)).toEqual({
      [kept]: { amount: 1, memo: "patched" },
      [made]: { amount: 3, memo: "new" },
    });
  });

  it("writes a batch once when its answer was lost and the batch is sent again", async () => {
    const { type, item } = await ledger();
    const actor = await writer(type);
    const row = uuidv7();
    const made = await client.writeRows(item, "lines", {
      operations: [{ op: "put", id: row, values: { amount: 1 } }],
    });
    expect(made.status, JSON.stringify(made.error)).toBe(200);
    const send = keyed(actor, `/items/${item}/tables/lines/rows`, {
      operations: [{ op: "delete", id: row }],
    });
    await send();
    expect(await values(item), "the first send applied").toEqual({});
    const before = await batches(item);

    const retried = await send();
    expect(retried.status, JSON.stringify(retried.error)).toBe(200);
    expect(retried.headers.get("Idempotency-Replayed")).toBe("true");
    expect(
      (retried.data as { results: { outcome: string }[] }).results[0]?.outcome,
      "a delete that ran again would answer absent",
    ).toBe("deleted");
    expect(await batches(item)).toBe(before);
  });

  it("refuses a key sent again with another batch, writing nothing", async () => {
    const { type, item } = await ledger();
    const actor = await writer(type);
    const row = uuidv7();
    const made = await client.writeRows(item, "lines", {
      operations: [{ op: "put", id: row, values: { amount: 1, memo: "a" } }],
    });
    expect(made.status, JSON.stringify(made.error)).toBe(200);
    const headers = { "Idempotency-Key": `rows-${randomUUID()}` };
    const path = `/items/${item}/tables/lines/rows`;
    const first = await actor.client.rawRequest<unknown>(path, {
      method: "POST",
      headers,
      body: { operations: [{ op: "patch", id: row, values: { memo: "one" } }] },
    });
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    const logged = await batches(item);
    for (const operation of [
      { op: "patch", id: row, values: { memo: "two" } },
      { op: "delete", id: row },
    ]) {
      const other = await actor.client.rawRequest<unknown>(path, {
        method: "POST",
        headers,
        body: { operations: [operation] },
      });
      expect(other.status, JSON.stringify(other.error)).toBe(422);
      expect(other.error?.error.code).toBe("idempotency_key_reused");
      expect(other.headers.get("Idempotency-Replayed")).toBeNull();
    }
    expect(await values(item)).toEqual({ [row]: { amount: 1, memo: "one" } });
    expect(await batches(item)).toBe(logged);
  });
});
