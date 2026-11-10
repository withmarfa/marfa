import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type {
  RowOperation,
  RowUndoAnswer,
  TableRow,
  TestContext,
} from "../../client/types.js";
import {
  createTestContext,
  trackItem,
  trackKey,
  cleanup,
} from "../../utils/setup.js";
import type { SseEvent } from "../../utils/sse.js";
import { tapStream } from "../../utils/stream-tap.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl, apiKey } = await createTestContext(
    "compliance",
    "table-rows-undo",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

let counter = 0;

function typeId(label: string): string {
  counter += 1;
  return `user.rows-undo-${label}-${counter}-${ctx.runId}`;
}

const LEDGER = {
  lines: { columns: { amount: { type: "number" }, memo: { type: "string" } } },
  other: { columns: { text: { type: "string" } } },
};

async function ledgerType(
  tables: Record<string, unknown> = LEDGER,
  id = typeId("ledger"),
): Promise<string> {
  const made = await client.registerType({
    id,
    fields: { title: { type: "string" } },
    tables,
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return id;
}

async function itemOf(type: string, title = "Ledger"): Promise<string> {
  const made = await client.createItem({
    type,
    properties: { title },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  trackItem(ctx, made.data.item.id);
  return made.data.item.id;
}

async function write(
  item: string,
  operations: RowOperation[],
  table = "lines",
  writer = client,
): Promise<string> {
  const res = await writer.writeRows(item, table, { operations });
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  expect(res.data.batch).not.toBeNull();
  return res.data.batch!;
}

async function undo(
  item: string,
  batch: string,
  table = "lines",
  writer = client,
): Promise<RowUndoAnswer> {
  const res = await writer.undoBatch(item, table, batch);
  expect(res.status, JSON.stringify(res.error)).toBe(200);
  return res.data;
}

async function rows(
  item: string,
  table = "lines",
): Promise<Record<string, unknown>> {
  const listed = await client.listRows(item, table, { limit: 1000 });
  expect(listed.status, JSON.stringify(listed.error)).toBe(200);
  return Object.fromEntries(
    listed.data.data.map((row: TableRow) => [row.id, row.values]),
  );
}

async function keyClient(types: Record<string, string>): Promise<MarfaClient> {
  counter += 1;
  const made = await client.createKey({
    label: `table-rows-undo-${counter}`,
    source: `${ctx.source}-k${counter}`,
    type_permissions: types,
  });
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  trackKey(ctx, made.data.id);
  return new MarfaClient({ baseUrl: apiUrl, apiKey: made.data.key });
}

/** Four row ids in ascending order. */
function ids(): [string, string, string, string] {
  const made = [uuidv7(), uuidv7(), uuidv7(), uuidv7()].sort();
  return [made[0]!, made[1]!, made[2]!, made[3]!];
}

/**
 * A batch that replaces r1, patches r2, deletes r3 and creates r4, over a
 * first batch that made r1 to r3.
 */
async function mixedBatch(item: string) {
  const [r1, r2, r3, r4] = ids();
  await write(item, [
    { op: "put", id: r1, values: { amount: 1, memo: "a" } },
    { op: "put", id: r2, values: { amount: 2 } },
    { op: "put", id: r3, values: { amount: 3 } },
  ]);
  const before = await rows(item);
  const batch = await write(item, [
    { op: "put", id: r1, values: { amount: 10 } },
    { op: "patch", id: r2, values: { memo: "b" } },
    { op: "delete", id: r3 },
    { op: "put", id: r4, values: { amount: 4 } },
  ]);
  return { r1, r2, r3, r4, before, batch };
}

describe("undoing a batch", () => {
  it("undoes a batch, putting back rows it replaced, patched and deleted and removing rows it created", async () => {
    const item = await itemOf(await ledgerType());
    const { before, batch, r4 } = await mixedBatch(item);
    expect(Object.keys(await rows(item))).toContain(r4);
    await undo(item, batch);
    expect(await rows(item)).toEqual(before);
  });

  it("answers each row of the undone batch in id order with its outcome, and moves last_activity_at", async () => {
    const item = await itemOf(await ledgerType());
    const { r1, r2, r3, r4, batch } = await mixedBatch(item);
    const read = (await client.getItem(item)).data.item;
    await new Promise((r) => setTimeout(r, 5));
    const answer = await undo(item, batch);
    expect(answer.undoes).toBe(batch);
    expect(answer.batch).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(answer.batch).not.toBe(batch);
    expect(answer.results).toEqual([
      { id: r1, outcome: "replaced" },
      { id: r2, outcome: "replaced" },
      { id: r3, outcome: "created" },
      { id: r4, outcome: "deleted" },
    ]);
    const after = (await client.getItem(item)).data.item;
    expect(after.last_activity_at).toBe(answer.last_activity_at);
    expect(after.last_activity_at! > read.last_activity_at!).toBe(true);
    expect(after.updated_at).toBe(read.updated_at);
    expect(after.version).toBe(read.version);
  });

  it("redoes a batch by undoing its undo, and undoes it again", async () => {
    const item = await itemOf(await ledgerType());
    const [r1, r2] = ids();
    await write(item, [{ op: "put", id: r1, values: { amount: 1 } }]);
    const batch = await write(item, [
      { op: "patch", id: r1, values: { amount: 2 } },
      { op: "put", id: r2, values: { amount: 5 } },
    ]);
    const undone = await undo(item, batch);
    expect(await rows(item)).toEqual({ [r1]: { amount: 1 } });

    const redone = await undo(item, undone.batch!);
    expect(redone.undoes).toBe(undone.batch);
    expect(redone.results).toEqual([
      { id: r1, outcome: "replaced" },
      { id: r2, outcome: "created" },
    ]);
    expect(await rows(item)).toEqual({
      [r1]: { amount: 2 },
      [r2]: { amount: 5 },
    });

    const again = await undo(item, redone.batch!);
    expect(again.undoes).toBe(redone.batch);
    expect(await rows(item)).toEqual({ [r1]: { amount: 1 } });
  });

  it("undoes a run of batches newest first, and redoes them oldest first", async () => {
    const item = await itemOf(await ledgerType());
    const [r1] = ids();
    await write(item, [{ op: "put", id: r1, values: { amount: 1 } }]);
    const states: Record<string, unknown>[] = [await rows(item)];
    const made: string[] = [];
    for (const amount of [2, 3, 4]) {
      made.push(
        await write(item, [{ op: "patch", id: r1, values: { amount } }]),
      );
      states.push(await rows(item));
    }
    const undos: string[] = [];
    for (let n = made.length - 1; n >= 0; n -= 1) {
      undos.unshift((await undo(item, made[n]!)).batch!);
      expect(await rows(item)).toEqual(states[n]);
    }
    for (let n = 0; n < undos.length; n += 1) {
      await undo(item, undos[n]!);
      expect(await rows(item)).toEqual(states[n + 1]);
    }
    const refused = await client.undoBatch(item, "lines", made[0]!);
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("undo_conflict");
  });

  it("answers batch null for an undo sent again, changing nothing", async () => {
    const item = await itemOf(await ledgerType());
    const { r1, r2, r3, r4, batch, before } = await mixedBatch(item);
    const first = await undo(item, batch);
    expect(first.batch).not.toBeNull();
    const listed = (await client.listBatches(item, "lines")).data.data;

    const second = await undo(item, batch);
    expect(second.batch).toBeNull();
    expect(second.undoes).toBe(batch);
    expect(second.results).toEqual(
      [r1, r2, r3, r4].map((id) => ({ id, outcome: "unchanged" })),
    );
    expect(await rows(item)).toEqual(before);
    expect((await client.listBatches(item, "lines")).data.data).toEqual(listed);
  });

  it("undoes a batch where a later batch left a row as it was before the batch", async () => {
    const item = await itemOf(await ledgerType());
    const [r1, r2] = ids();
    await write(item, [{ op: "put", id: r1, values: { amount: 1 } }]);
    const batch = await write(item, [
      { op: "patch", id: r1, values: { amount: 2 } },
      { op: "put", id: r2, values: { amount: 7 } },
    ]);
    await write(item, [{ op: "patch", id: r1, values: { amount: 1 } }]);
    const answer = await undo(item, batch);
    expect(answer.results).toEqual([
      { id: r1, outcome: "unchanged" },
      { id: r2, outcome: "deleted" },
    ]);
    expect(await rows(item)).toEqual({ [r1]: { amount: 1 } });
  });

  it("undoes an earlier batch once a later batch that left its rows as it found them is undone", async () => {
    const item = await itemOf(await ledgerType());
    const [r1, r2] = ids();
    const earlier = await write(item, [
      { op: "put", id: r1, values: { amount: 1 } },
      { op: "put", id: r2, values: { amount: 2 } },
    ]);
    const later = await write(item, [
      { op: "patch", id: r1, values: { amount: 5 } },
      { op: "patch", id: r1, values: { amount: 1 } },
    ]);
    // The witness: while the later batch stands, it holds back the earlier one.
    const held = await client.undoBatch(item, "lines", earlier);
    expect(held.status).toBe(409);
    expect(held.error?.error.details).toEqual({ rows: [r1] });

    const nothing = await undo(item, later);
    expect(nothing.batch).toBeNull();
    expect(nothing.results).toEqual([{ id: r1, outcome: "unchanged" }]);
    const answer = await undo(item, earlier);
    expect(answer.results).toEqual([
      { id: r1, outcome: "deleted" },
      { id: r2, outcome: "deleted" },
    ]);
    expect(await rows(item)).toEqual({});
  });

  it("puts back values in a column the type has since removed", async () => {
    const id = typeId("removed");
    await ledgerType(LEDGER, id);
    const item = await itemOf(id);
    const [r1] = ids();
    await write(item, [
      { op: "put", id: r1, values: { amount: 1, memo: "a" } },
    ]);
    const batch = await write(item, [
      { op: "patch", id: r1, values: { memo: "b" } },
    ]);
    const forced = await client.replaceType(
      id,
      {
        id,
        fields: { title: { type: "string" } },
        tables: {
          lines: { columns: { amount: { type: "number" } } },
          other: LEDGER.other,
        },
      },
      true,
    );
    expect(forced.status, JSON.stringify(forced.error)).toBe(200);
    await undo(item, batch);
    expect((await client.getRow(item, "lines", r1)).data.values).toEqual({
      amount: 1,
      memo: "a",
    });
  });

  it("answers table_not_found for an undo once a forced change removed the table", async () => {
    const id = typeId("gone");
    await ledgerType(LEDGER, id);
    const item = await itemOf(id);
    const batch = await write(
      item,
      [{ op: "put", values: { text: "x" } }],
      "other",
    );
    const forced = await client.replaceType(
      id,
      {
        id,
        fields: { title: { type: "string" } },
        tables: { lines: LEDGER.lines },
      },
      true,
    );
    expect(forced.status, JSON.stringify(forced.error)).toBe(200);
    const refused = await client.undoBatch(item, "other", batch);
    expect(refused.status).toBe(404);
    expect(refused.error?.error.code).toBe("table_not_found");
  });
});

describe("an undo it cannot make", () => {
  it("refuses an undo where a later batch changed a row, naming the rows, and changes nothing", async () => {
    const item = await itemOf(await ledgerType());
    const [r1, r2, r3] = ids();
    await write(item, [
      { op: "put", id: r1, values: { amount: 1 } },
      { op: "put", id: r2, values: { amount: 2 } },
      { op: "put", id: r3, values: { amount: 3 } },
    ]);
    const batch = await write(item, [
      { op: "patch", id: r1, values: { amount: 10 } },
      { op: "patch", id: r2, values: { amount: 20 } },
      { op: "patch", id: r3, values: { amount: 30 } },
    ]);
    const later = await write(item, [
      { op: "patch", id: r3, values: { memo: "later" } },
      { op: "patch", id: r1, values: { memo: "later" } },
    ]);
    const held = await rows(item);
    const refused = await client.undoBatch(item, "lines", batch);
    expect(refused.status).toBe(409);
    expect(refused.error?.error.code).toBe("undo_conflict");
    expect(refused.error?.error.details).toEqual({ rows: [r1, r3] });
    expect(await rows(item)).toEqual(held);

    await undo(item, later);
    await undo(item, batch);
    expect(await rows(item)).toEqual({
      [r1]: { amount: 1 },
      [r2]: { amount: 2 },
      [r3]: { amount: 3 },
    });
  });

  it("takes a row the batch deleted as standing while the table holds no row with its id", async () => {
    const item = await itemOf(await ledgerType());
    const [r1] = ids();
    await write(item, [{ op: "put", id: r1, values: { amount: 1 } }]);
    const batch = await write(item, [{ op: "delete", id: r1 }]);
    await write(item, [{ op: "put", id: r1, values: { amount: 9 } }]);
    const refused = await client.undoBatch(item, "lines", batch);
    expect(refused.status).toBe(409);
    expect(refused.error?.error).toMatchObject({
      code: "undo_conflict",
      details: { rows: [r1] },
    });

    await write(item, [{ op: "delete", id: r1 }]);
    const answer = await undo(item, batch);
    expect(answer.results).toEqual([{ id: r1, outcome: "created" }]);
    expect(await rows(item)).toEqual({ [r1]: { amount: 1 } });
  });

  it("answers batch_not_found for a batch of another table or item, and an id no batch has", async () => {
    const type = await ledgerType();
    const item = await itemOf(type);
    const second = await itemOf(type, "Second");
    const batch = await write(item, [{ op: "put", values: { amount: 1 } }]);
    await write(second, [{ op: "put", values: { amount: 2 } }]);
    // The witness: the batch is there to undo on its own table.
    const listed = (await client.listBatches(item, "lines")).data.data;
    expect(listed.map((b) => b.id)).toEqual([batch]);
    for (const res of [
      await client.undoBatch(second, "lines", batch),
      await client.undoBatch(item, "other", batch),
      await client.undoBatch(item, "lines", uuidv7()),
      await client.undoBatch(item, "lines", "not-a-batch"),
    ]) {
      expect(res.status).toBe(404);
      expect(res.error?.error.code).toBe("batch_not_found");
    }
    expect(Object.values(await rows(item))).toEqual([{ amount: 1 }]);
  });

  it("refuses an undo by a key that may read and not write, and on an item in the bin, and undoes once the item is back", async () => {
    const type = await ledgerType();
    const item = await itemOf(type);
    const batch = await write(item, [{ op: "put", values: { amount: 1 } }]);

    const reader = await keyClient({ [type]: "read" });
    const read = await reader.undoBatch(item, "lines", batch);
    expect(read.status).toBe(403);
    expect(read.error?.error.code).toBe("type_not_permitted");

    const stranger = await keyClient({ "core.note": "write" });
    const unseen = await stranger.undoBatch(item, "lines", batch);
    expect(unseen.status).toBe(404);
    expect(unseen.error?.error.code).toBe("item_not_found");

    expect((await client.deleteItem(item)).status).toBe(200);
    const binned = await client.undoBatch(item, "lines", batch);
    expect(binned.status).toBe(404);
    expect(binned.error?.error).toEqual(
      expect.objectContaining({
        code: "item_not_found",
        details: { trashed: true },
      }),
    );

    expect((await client.restoreItem(item)).status).toBe(200);
    expect(Object.keys(await rows(item))).toHaveLength(1);
    const answer = await undo(item, batch);
    expect(answer.results.map((r) => r.outcome)).toEqual(["deleted"]);
    expect(await rows(item)).toEqual({});
  });

  it("refuses an undo of a row holding a value the key may not read, and removes a created row holding one", async () => {
    const hiddenType = typeId("hidden");
    expect(
      (
        await client.registerType({
          id: hiddenType,
          fields: { title: { type: "string" } },
        } as never)
      ).status,
    ).toBe(201);
    const hidden = await itemOf(hiddenType, "Hidden");
    const note = await client.createItem({
      type: "core.note",
      properties: { title: "Shown" },
    } as never);
    trackItem(ctx, note.data.item.id);
    const shown = note.data.item.id;
    const type = await ledgerType({
      lines: {
        columns: { amount: { type: "number" }, about: { type: "item" } },
      },
    });
    const item = await itemOf(type);
    const narrow = await keyClient({ [type]: "write", "core.note": "read" });
    const [r1, r2, r3] = ids();
    await write(item, [
      { op: "put", id: r1, values: { amount: 1, about: hidden } },
      { op: "put", id: r2, values: { amount: 2, about: shown } },
    ]);

    // Put back: the narrow key deletes a row it may delete, and may not bring it back.
    const deleted = await write(
      item,
      [{ op: "delete", id: r1 }],
      "lines",
      narrow,
    );
    const putBack = await narrow.undoBatch(item, "lines", deleted);
    expect(putBack.status).toBe(403);
    expect(putBack.error?.error).toMatchObject({
      code: "forbidden",
      details: { row: r1, column: "about" },
    });
    expect(Object.keys(await rows(item))).toEqual([r2]);
    await undo(item, deleted);
    expect((await client.getRow(item, "lines", r1)).data.values).toEqual({
      amount: 1,
      about: hidden,
    });

    // Replace: undoing the owner's change would remove a value the key may not read.
    const owners = await write(item, [
      { op: "patch", id: r2, values: { about: hidden } },
    ]);
    const replaced = await narrow.undoBatch(item, "lines", owners);
    expect(replaced.status).toBe(403);
    expect(replaced.error?.error).toMatchObject({
      code: "forbidden",
      details: { row: r2, column: "about" },
    });
    expect((await client.getRow(item, "lines", r2)).data.values).toEqual({
      amount: 2,
      about: hidden,
    });

    // A row holding a withheld value refuses an undo that leaves the column alone.
    const amounts = await write(item, [
      { op: "patch", id: r1, values: { amount: 5 } },
    ]);
    const alone = await narrow.undoBatch(item, "lines", amounts);
    expect(alone.status).toBe(403);
    expect(alone.error?.error).toMatchObject({
      code: "forbidden",
      details: { row: r1, column: "about" },
    });
    expect((await client.getRow(item, "lines", r1)).data.values).toEqual({
      amount: 5,
      about: hidden,
    });

    // The witness: an undo of a row whose values the key reads goes through.
    const [r4] = ids();
    await write(item, [{ op: "put", id: r4, values: { amount: 4, about: shown } }]);
    const plain = await write(item, [
      { op: "patch", id: r4, values: { amount: 6 } },
    ]);
    const undone = await undo(item, plain, "lines", narrow);
    expect(undone.results).toEqual([{ id: r4, outcome: "replaced" }]);
    expect((await client.getRow(item, "lines", r4)).data.values).toEqual({
      amount: 4,
      about: shown,
    });

    // A created row holding a withheld value is removed.
    const created = await write(item, [
      { op: "put", id: r3, values: { amount: 3, about: hidden } },
    ]);
    const removed = await undo(item, created, "lines", narrow);
    expect(removed.results).toEqual([{ id: r3, outcome: "deleted" }]);
    expect((await client.getRow(item, "lines", r3)).status).toBe(404);
  });
  it("refuses an undo to a key that may not read a value a row held before or after the batch, whatever the row holds now", async () => {
    const hiddenType = typeId("unseen");
    expect(
      (
        await client.registerType({
          id: hiddenType,
          fields: { title: { type: "string" } },
        } as never)
      ).status,
    ).toBe(201);
    const between = await itemOf(hiddenType, "Between");
    const since = await itemOf(hiddenType, "Since");
    const note = await client.createItem({
      type: "core.note",
      properties: { title: "Shown" },
    } as never);
    trackItem(ctx, note.data.item.id);
    const shown = note.data.item.id;
    const type = await ledgerType({
      lines: { columns: { about: { type: "item" } } },
    });
    const narrow = await keyClient({ [type]: "write", "core.note": "read" });
    const [r1] = ids();
    const answers: unknown[] = [];
    const owners: number[] = [];
    // The row goes shown, then hidden, then back to shown or on to another hidden item.
    for (const now of [shown, since]) {
      const item = await itemOf(type);
      await write(item, [{ op: "put", id: r1, values: { about: shown } }]);
      const batch = await write(item, [
        { op: "patch", id: r1, values: { about: between } },
      ]);
      await write(item, [{ op: "patch", id: r1, values: { about: now } }]);
      const held = await rows(item);
      const refused = await narrow.undoBatch(item, "lines", batch);
      answers.push({ status: refused.status, body: refused.error });
      expect(await rows(item)).toEqual(held);
      owners.push((await client.undoBatch(item, "lines", batch)).status);
    }
    expect(answers[0]).toEqual({
      status: 403,
      body: {
        error: {
          code: "forbidden",
          message: expect.any(String),
          details: { row: r1, column: "about" },
        },
      },
    });
    expect(answers[1]).toEqual(answers[0]);
    // The witness: to a key that reads every value, the two rows answer apart.
    expect(owners).toEqual([200, 409]);
  });
});

const rowsFor =
  (item: string) =>
  (event: SseEvent): boolean =>
    event.event === "rows.changed" &&
    (event.data as { item?: { id?: string } }).item?.id === item;

describe("announcing an undo", () => {
  it("announces one rows.changed for an undo naming the batch it undid, and nothing for an undo that changes nothing", async () => {
    const type = await ledgerType();
    const item = await itemOf(type);
    const [r1, r2] = ids();
    await write(item, [{ op: "put", id: r1, values: { amount: 1 } }]);
    const batch = await write(item, [
      { op: "patch", id: r1, values: { amount: 2 } },
      { op: "put", id: r2, values: { amount: 5 } },
    ]);
    const tap = await tapStream(apiUrl, apiKey);
    try {
      await tap.until(
        (seen) => seen.some((e) => e.event === "stream_live"),
        "the stream going live",
      );
      const answer = await undo(item, batch);
      const nothing = await undo(item, batch);
      expect(nothing.batch).toBeNull();
      const witness = await write(item, [{ op: "put", values: { amount: 9 } }]);
      const events = await tap.until(
        (seen) =>
          seen.some(
            (e) =>
              rowsFor(item)(e) &&
              (e.data as { batch?: string }).batch === witness,
          ),
        "the witness batch",
      );
      const frames = events.filter(rowsFor(item)).map((e) => e.data);
      expect(frames).toHaveLength(2);
      expect(frames[0]).toMatchObject({
        event_type: "rows.changed",
        item: { id: item, type, source: ctx.source },
        table: "lines",
        batch: answer.batch,
        undoes: batch,
        last_activity_at: answer.last_activity_at,
        rows: [
          { id: r1, values: { amount: 1 } },
          { id: r2, deleted: true },
        ],
      });
      expect(frames[1]).not.toHaveProperty("undoes");
    } finally {
      await tap.close();
    }
  });
});

describe("listing a table's batches", () => {
  it("lists the table's batches newest first, with the rows each changed and what it undid", async () => {
    const item = await itemOf(await ledgerType());
    const [r1, r2, r3] = ids();
    const first = await client.writeRows(item, "lines", {
      operations: [
        { op: "put", id: r1, values: { amount: 1 } },
        { op: "put", id: r2, values: { amount: 2 } },
        { op: "put", id: r3, values: { amount: 3 } },
      ],
    });
    const second = await client.writeRows(item, "lines", {
      operations: [
        { op: "patch", id: r1, values: { amount: 10 } },
        { op: "patch", id: r1, values: { amount: 11 } },
        { op: "delete", id: r2 },
        { op: "delete", id: uuidv7() },
      ],
    });
    await write(item, [{ op: "put", values: { text: "elsewhere" } }], "other");
    const undone = await undo(item, second.data.batch!);
    const listed = await client.listBatches(item, "lines");
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    expect(listed.data).toEqual({
      data: [
        {
          id: undone.batch,
          at: undone.last_activity_at,
          rows: 2,
          undoes: second.data.batch,
        },
        {
          id: second.data.batch,
          at: second.data.last_activity_at,
          rows: 2,
          undoes: null,
        },
        {
          id: first.data.batch,
          at: first.data.last_activity_at,
          rows: 3,
          undoes: null,
        },
      ],
      next_cursor: null,
    });
  });

  it("pages the batches by a signed cursor, and refuses a limit or cursor it did not answer", async () => {
    const item = await itemOf(await ledgerType());
    const made: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      made.unshift(await write(item, [{ op: "put", values: { amount: n } }]));
    }
    const page = await client.listBatches(item, "lines", { limit: 2 });
    expect(page.status, JSON.stringify(page.error)).toBe(200);
    expect(page.data.data.map((b) => b.id)).toEqual(made.slice(0, 2));
    expect(page.data.next_cursor).toEqual(expect.any(String));
    const rest = await client.listBatches(item, "lines", {
      limit: 2,
      cursor: page.data.next_cursor!,
    });
    expect(rest.data.data.map((b) => b.id)).toEqual(made.slice(2));
    expect(rest.data.next_cursor).toBeNull();

    for (const limit of [0, 1001, 1.5]) {
      const refused = await client.listBatches(item, "lines", { limit });
      expect(refused.status, String(limit)).toBe(400);
      expect(refused.error?.error.code).toBe("validation_error");
      expect(refused.error?.error.details).toMatchObject({ field: "limit" });
    }
    await write(item, [{ op: "put", values: { text: "x" } }], "other");
    const elsewhere = await client.listBatches(item, "other", {
      cursor: page.data.next_cursor!,
    });
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.error?.error).toMatchObject({
      code: "validation_error",
      details: { field: "cursor" },
    });
  });
});
