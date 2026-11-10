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

function keyed(by: Writer, path: string, body?: unknown): () => Promise<Answer> {
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
    expect(await values(item)).toEqual({ [row]: { amount: 1, memo: "between" } });
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
    expect(await values(item)).toEqual({ [row]: { amount: 1 } });
    const logged = await batches(item);

    expectReplay(await send(), first);
    expect(await values(item)).toEqual({ [row]: { amount: 1 } });
    expect(await batches(item), "the repeat undid the batch again").toBe(logged);
  });
});
