import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type {
  RestoreArchiveResponse,
  TableRow,
  TableSummary,
  TestContext,
} from "../../client/types.js";
import {
  archiveLines,
  archiveManifest,
  editLineFile,
  itemsArchive,
  listEntries,
  ndjson,
} from "../../utils/archive.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  cleanup,
  createTestContext,
  getOwnerClient,
  trackItem,
} from "../../utils/setup.js";
import type { SseEvent } from "../../utils/sse.js";
import { tapStream, type StreamTap } from "../../utils/stream-tap.js";

/**
 * Rows through `GET /export?format=archive` and `POST /restore`: one export
 * from a fresh source, restored into a fresh destination, which each test
 * reads for its own part; and archives built here for what a restore refuses,
 * restored into the run's server.
 */

interface RowLine {
  item_id: string;
  table: string;
  id: string;
  values: Record<string, unknown>;
  refs?: string[];
  updated_at: string;
}

const LEDGER = "user.rows_archive_ledger";
const SECRET = "user.rows_archive_secret";
const SHAPED = "user.rows_archive_shaped";
const EVENTS = "user.rows_archive_events";
const MANY = 2500;

let source: FreshServer;
let destination: FreshServer;
let origin: MarfaClient;
let restoredInto: MarfaClient;
let destinationOwner: MarfaClient;
let archive: Uint8Array;
let restored: RestoreArchiveResponse;
let tap: StreamTap;

const made = {
  first: "",
  second: "",
  target: "",
  secret: "",
  shaped: "",
  busy: "",
  photoRow: "",
  captionRow: "",
  sourceRows: new Map<string, TableRow[]>(),
  sourceTables: new Map<string, TableSummary[]>(),
  lastActivity: "",
  updatedAt: "",
};

let ctx: TestContext;
let client: MarfaClient;

async function ok<T>(
  answer: Promise<{ status: number; data: T; error?: unknown }>,
  status = 200,
): Promise<T> {
  const settled = await answer;
  expect(settled.status, JSON.stringify(settled.error)).toBe(status);
  return settled.data;
}

async function register(
  on: MarfaClient,
  id: string,
  tables: Record<string, unknown>,
) {
  await ok(
    on.registerType({
      id,
      fields: { title: { type: "string" } },
      tables,
    } as never),
    201,
  );
}

async function item(on: MarfaClient, type: string, title: string) {
  return (
    await ok(on.createItem({ type, properties: { title } } as never), 201)
  ).item;
}

async function put(
  on: MarfaClient,
  itemId: string,
  table: string,
  rows: { id?: string; values: Record<string, unknown> }[],
) {
  return ok(
    on.writeRows(itemId, table, {
      operations: rows.map((row) => ({ op: "put" as const, ...row })),
    }),
  );
}

async function allRows(on: MarfaClient, itemId: string, table: string) {
  const rows: TableRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await ok(on.listRows(itemId, table, { limit: 1000, cursor }));
    rows.push(...page.data);
    if (page.next_cursor === null) return rows;
    cursor = page.next_cursor;
  }
}

/** The ids `count` rows get, in no order. */
function shuffledIds(count: number): string[] {
  const ids = Array.from({ length: count }, () => uuidv7());
  return ids.map((_, at) => ids[(at * 7) % count]!);
}

function compareLines(a: RowLine, b: RowLine): number {
  const key = (line: RowLine) => [line.item_id, line.table, line.id];
  const [x, y] = [key(a), key(b)];
  for (let at = 0; at < 3; at++) {
    if (x[at]! < y[at]!) return -1;
    if (x[at]! > y[at]!) return 1;
  }
  return 0;
}

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "compliance",
    "table-rows-archive",
  ));
  source = await bootFreshServer("rows-archive-source");
  destination = await bootFreshServer("rows-archive-destination");
  origin = new MarfaClient({
    baseUrl: source.apiUrl,
    apiKey: source.workingKey,
  });
  restoredInto = new MarfaClient({
    baseUrl: destination.apiUrl,
    apiKey: destination.workingKey,
  });
  destinationOwner = new MarfaClient({
    baseUrl: destination.apiUrl,
    controlSocket: destination.controlSocket,
  });

  await register(origin, SECRET, {});
  await register(origin, LEDGER, {
    lines: { columns: { amount: { type: "number" } } },
    notes: { columns: { text: { type: "string" } } },
    photos: {
      columns: { caption: { type: "string" }, picture: { type: "item" } },
    },
  });
  await register(origin, SHAPED, {
    lines: {
      columns: { amount: { type: "number" }, memo: { type: "string" } },
    },
    extra: { columns: { n: { type: "integer" } } },
  });
  await register(origin, EVENTS, {
    lines: { columns: { amount: { type: "number" } } },
  });

  const first = await item(origin, LEDGER, "first");
  const second = await item(origin, LEDGER, "second");
  const target = await item(origin, LEDGER, "target");
  const secret = await item(origin, SECRET, "secret");
  made.first = first.id;
  made.second = second.id;
  made.target = target.id;
  made.secret = secret.id;
  for (const id of [first.id, second.id]) {
    const ids = shuffledIds(5);
    await put(
      origin,
      id,
      "lines",
      ids.map((rowId, at) => ({ id: rowId, values: { amount: at } })),
    );
    await put(origin, id, "notes", [{ values: { text: `on ${id}` } }]);
  }
  const photos = await put(origin, first.id, "photos", [
    { values: { caption: "a target", picture: target.id } },
    { values: { caption: "words alone" } },
    { values: { caption: "a secret", picture: secret.id } },
  ]);
  made.photoRow = photos.results[0]!.id;
  made.captionRow = photos.results[1]!.id;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await put(origin, second.id, "notes", [{ values: { text: "later" } }]);

  const shaped = await item(origin, SHAPED, "shaped");
  made.shaped = shaped.id;
  await put(origin, shaped.id, "lines", [
    { values: { amount: 1, memo: "kept as text" } },
  ]);
  await put(origin, shaped.id, "extra", [{ values: { n: 3 } }]);
  await ok(
    origin.replaceType(
      SHAPED,
      {
        id: SHAPED,
        fields: { title: { type: "string" } },
        tables: {
          lines: {
            columns: { amount: { type: "number" }, memo: { type: "integer" } },
          },
        },
      },
      true,
    ),
  );

  const busy = await item(origin, EVENTS, "busy");
  made.busy = busy.id;
  for (let at = 0; at < MANY; at += 1000) {
    await put(
      origin,
      busy.id,
      "lines",
      Array.from({ length: Math.min(1000, MANY - at) }, (_, n) => ({
        values: { amount: at + n },
      })),
    );
  }

  for (const id of [first.id, second.id]) {
    for (const table of ["lines", "notes", "photos"]) {
      made.sourceRows.set(`${id}/${table}`, await allRows(origin, id, table));
    }
    made.sourceTables.set(id, (await ok(origin.listTables(id))).data);
  }
  const read = (await ok(origin.getItem(second.id))).item;
  made.lastActivity = read.last_activity_at!;
  made.updatedAt = read.updated_at!;

  const exported = await origin.exportArchive({});
  expect(exported.status).toBe(200);
  archive = exported.data;

  tap = await tapStream(destination.apiUrl, destination.workingKey);
  await tap.until(
    (seen) => seen.some((event) => event.event === "stream_live"),
    "the stream going live",
  );
  restored = await ok(destinationOwner.restoreArchive(archive));
}, FRESH_SERVER_TIMEOUT_MS * 3);

afterAll(async () => {
  await tap?.close();
  await source?.stop();
  await destination?.stop();
  await cleanup(ctx);
}, FRESH_SERVER_TIMEOUT_MS);

describe("rows in an archive", () => {
  it("carries each row of a carried item in rows.ndjson.gz, in table and id order, and counts them in row_count", () => {
    expect(listEntries(archive).map((entry) => entry.name)).toEqual([
      "manifest.json",
      "instance.ndjson.gz",
      "items.ndjson.gz",
      "edges.ndjson.gz",
      "rows.ndjson.gz",
    ]);
    const lines = archiveLines<RowLine>(archive, "rows");
    expect(lines).toEqual([...lines].sort(compareLines));
    expect(archiveManifest<{ row_count: number }>(archive).row_count).toBe(
      lines.length,
    );
    for (const [key, rows] of made.sourceRows) {
      const [itemId, table] = key.split("/");
      expect(
        lines
          .filter((line) => line.item_id === itemId && line.table === table)
          .map((line) => line.id)
          .sort(),
      ).toEqual(rows.map((row) => row.id).sort());
    }
    expect(lines.filter((line) => line.item_id === made.busy)).toHaveLength(
      MANY,
    );
  });

  it("carries a row's item_id, table, id, values and updated_at, and in refs the columns written as an item's id", () => {
    const lines = archiveLines<RowLine>(archive, "rows");
    const photos = made.sourceRows.get(`${made.first}/photos`)!;
    const read = (id: string) => photos.find((row) => row.id === id)!;
    expect(lines.find((line) => line.id === made.photoRow)).toEqual({
      item_id: made.first,
      table: "photos",
      id: made.photoRow,
      values: { caption: "a target", picture: made.target },
      refs: ["picture"],
      updated_at: read(made.photoRow).updated_at,
    });
    expect(lines.find((line) => line.id === made.captionRow)).toEqual({
      item_id: made.first,
      table: "photos",
      id: made.captionRow,
      values: { caption: "words alone" },
      updated_at: read(made.captionRow).updated_at,
    });
  });

  it("leaves out of an archive a value the exporting key may not read, and its mark", async () => {
    const narrow = await ok(
      new MarfaClient({
        baseUrl: source.apiUrl,
        controlSocket: source.controlSocket,
      }).createKey({
        label: "rows-archive-narrow",
        source: "rows-archive-narrow",
        type_permissions: { [LEDGER]: "read" },
      }),
      201,
    );
    const exported = await new MarfaClient({
      baseUrl: source.apiUrl,
      apiKey: narrow.key,
    }).exportArchive({});
    expect(exported.status).toBe(200);
    const secretRow = (lines: RowLine[]) =>
      lines.find(
        (line) => line.table === "photos" && line.values.caption === "a secret",
      );
    // The witness: the full export carries the value and its mark.
    expect(secretRow(archiveLines<RowLine>(archive, "rows"))).toMatchObject({
      values: { caption: "a secret", picture: made.secret },
      refs: ["picture"],
    });
    const narrowed = secretRow(archiveLines<RowLine>(exported.data, "rows"));
    expect(narrowed?.values).toEqual({ caption: "a secret" });
    expect(narrowed).not.toHaveProperty("refs");
    expect(
      archiveLines<RowLine>(exported.data, "rows").find(
        (line) => line.id === made.photoRow,
      ),
    ).toMatchObject({ values: { picture: made.target }, refs: ["picture"] });
  });

  it("restores each row with its values, refs and updated_at, and the tables' row counts and bytes", async () => {
    const lines = archiveLines<RowLine>(archive, "rows");
    expect(restored).toMatchObject({
      rows_imported: lines.length,
      rows_skipped: 0,
    });
    for (const [key, rows] of made.sourceRows) {
      const [itemId, table] = key.split("/");
      expect(await allRows(restoredInto, itemId!, table!)).toEqual(rows);
    }
    for (const [itemId, tables] of made.sourceTables) {
      const read = (await ok(restoredInto.listTables(itemId))).data;
      const counted = (list: TableSummary[]) =>
        list.map(({ name, row_count, bytes }) => ({ name, row_count, bytes }));
      expect(counted(read)).toEqual(counted(tables));
    }
    // A key that may not read the secret's type sees its id withheld, as the
    // mark says, on the restored instance.
    const narrow = await ok(
      destinationOwner.createKey({
        label: "rows-archive-restored-narrow",
        source: "rows-archive-restored-narrow",
        type_permissions: { [LEDGER]: "read" },
      }),
      201,
    );
    const seen = await allRows(
      new MarfaClient({ baseUrl: destination.apiUrl, apiKey: narrow.key }),
      made.first,
      "photos",
    );
    expect(seen.find((row) => row.values.caption === "a secret")).toEqual(
      expect.objectContaining({
        values: { caption: "a secret" },
        withheld: ["picture"],
      }),
    );
  });

  it("keeps an item's last_activity_at through a restore", async () => {
    expect(made.lastActivity > made.updatedAt).toBe(true);
    const read = (await ok(restoredInto.getItem(made.second))).item;
    expect(read.last_activity_at).toBe(made.lastActivity);
    expect(read.updated_at).toBe(made.updatedAt);
  });

  it("leaves the rows of an item counted as a duplicate as they are, counting the archive's in rows_skipped", async () => {
    const row = made.sourceRows.get(`${made.first}/lines`)![0]!;
    await ok(
      restoredInto.writeRows(made.first, "lines", {
        operations: [{ op: "patch", id: row.id, values: { amount: 99 } }],
      }),
    );
    const again = await ok(destinationOwner.restoreArchive(archive));
    const lines = archiveLines<RowLine>(archive, "rows");
    expect(again).toMatchObject({
      imported: 0,
      rows_imported: 0,
      rows_skipped: lines.length,
    });
    expect(
      (await ok(restoredInto.getRow(made.first, "lines", row.id))).values,
    ).toEqual({ amount: 99 });
  });
  it("carries a row of a table its type no longer declares, and a value its column no longer takes, and restores both as held", async () => {
    const lines = archiveLines<RowLine>(archive, "rows").filter(
      (line) => line.item_id === made.shaped,
    );
    expect(lines.map(({ table, values }) => ({ table, values }))).toEqual([
      { table: "extra", values: { n: 3 } },
      { table: "lines", values: { amount: 1, memo: "kept as text" } },
    ]);
    expect(
      (await allRows(restoredInto, made.shaped, "lines")).map(
        (row) => row.values,
      ),
    ).toEqual([{ amount: 1, memo: "kept as text" }]);
    // The table the type no longer declares holds its row again once the
    // type declares it.
    await ok(
      restoredInto.replaceType(SHAPED, {
        id: SHAPED,
        fields: { title: { type: "string" } },
        tables: {
          lines: {
            columns: { amount: { type: "number" }, memo: { type: "integer" } },
          },
          extra: { columns: { n: { type: "integer" } } },
        },
      }),
    );
    expect(
      (await allRows(restoredInto, made.shaped, "extra")).map(
        (row) => row.values,
      ),
    ).toEqual([{ n: 3 }]);
  });

  it("announces restored rows in rows.changed of at most 1000 rows", async () => {
    const frames = (seen: SseEvent[]) =>
      seen.filter(
        (event) =>
          event.event === "rows.changed" &&
          (event.data as { item?: { id?: string } }).item?.id === made.busy,
      );
    const seen = frames(
      await tap.until(
        (events) =>
          frames(events).reduce(
            (sum, event) =>
              sum + (event.data as { rows: unknown[] }).rows.length,
            0,
          ) >= MANY,
        "the restored rows announced",
      ),
    );
    const sizes = seen.map(
      (event) => (event.data as { rows: unknown[] }).rows.length,
    );
    expect(sizes).toEqual([1000, 1000, 500]);
    const batches = seen.map(
      (event) => (event.data as { batch: string }).batch,
    );
    expect(new Set(batches).size).toBe(3);
    const summary = (await ok(restoredInto.listTables(made.busy))).data.find(
      (table) => table.name === "lines",
    );
    expect(summary?.last_batch).toBe(batches[2]);
  });
});

describe("a row line a restore refuses", () => {
  const owner = () => getOwnerClient();
  const typeFor = (label: string) =>
    `user.rows_refused_${label}_${ctx.runId.replace(/[^a-z0-9]/g, "")}`;

  /** An archive of one item of a type with a table, holding `rows`. */
  function withRows(
    label: string,
    rows: (itemId: string) => unknown[],
  ): { archive: Uint8Array; itemId: string; type: string } {
    const itemId = uuidv7();
    const type = typeFor(label);
    const base = itemsArchive(
      [{ id: itemId, type, source: ctx.source, properties: {} }],
      [],
      [
        {
          id: type,
          label: "Refused rows",
          version: 1,
          fields: {},
          tables: {
            lines: {
              columns: {
                amount: { type: "number" },
                text: { type: "string" },
                photo: { type: "item" },
              },
            },
          },
        },
      ],
    );
    return {
      archive: editLineFile(base, "rows", () => ndjson(rows(itemId))),
      itemId,
      type,
    };
  }

  const row = (itemId: string, extra: Record<string, unknown> = {}) => ({
    item_id: itemId,
    table: "lines",
    id: uuidv7(),
    values: { amount: 1 },
    updated_at: new Date().toISOString(),
    ...extra,
  });

  async function refusedAt(
    archive: Uint8Array,
    itemId: string,
    line: number,
    field?: string,
  ) {
    const refused = await owner().restoreArchive(archive);
    expect(refused.status, JSON.stringify(refused.error)).toBe(400);
    expect(refused.error?.error.code).toBe("validation_error");
    expect(refused.error?.error.details?.line).toBe(line);
    if (field !== undefined) {
      expect(refused.error?.error.details?.field).toBe(field);
    }
    expect((await client.getItem(itemId)).status).toBe(404);
  }

  async function restoresWith(
    label: string,
    rows: (itemId: string) => unknown[],
  ) {
    const good = withRows(label, rows);
    const accepted = await owner().restoreArchive(good.archive);
    expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true);
    trackItem(ctx, good.itemId);
    return { good, accepted: accepted.data };
  }

  it("refuses a row naming an item the archive does not hold, naming its line, and writes nothing", async () => {
    const bad = withRows("missing", (itemId) => [row(itemId), row(uuidv7())]);
    await refusedAt(bad.archive, bad.itemId, 2, "item_id");

    // The witness: the same rows naming the archive's item restore.
    const { good, accepted } = await restoresWith("missing-witness", (id) =>
      [row(id), row(id)].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
    expect(accepted.rows_imported).toBe(2);
    expect(await allRows(client, good.itemId, "lines")).toHaveLength(2);
  });

  const malformed: [string, string, Record<string, unknown>][] = [
    ["table", "table", { table: "Not A Name" }],
    ["id", "id", { id: "not-an-id" }],
    ["id in uppercase", "id", { id: uuidv7().toUpperCase() }],
    ["values", "values", { values: "text" }],
    ["updated_at", "updated_at", { updated_at: "not-a-date" }],
    ["refs as text", "refs", { refs: "photo" }],
    ["refs naming a column holding no item id", "refs", { refs: ["amount"] }],
    [
      "refs naming a column twice",
      "refs",
      { values: { photo: uuidv7() }, refs: ["photo", "photo"] },
    ],
  ];

  it.each(malformed)(
    "refuses a row line whose %s is malformed, naming its line and field, and writes nothing",
    async (_label, field, damage) => {
      const bad = withRows(`bad-${field}`, (itemId) => [row(itemId, damage)]);
      await refusedAt(bad.archive, bad.itemId, 1, field);

      // The witness: the same row, undamaged, restores, refs and all.
      const { good } = await restoresWith(`bad-${field}-witness`, (itemId) => [
        row(itemId, { values: { photo: itemId }, refs: ["photo"] }),
      ]);
      expect((await allRows(client, good.itemId, "lines"))[0]?.values).toEqual({
        photo: good.itemId,
      });
    },
  );

  const notObjects: [string, unknown][] = [
    ["null", null],
    ["a number", 5],
    ["a string", "text"],
    ["an array", [row("x")]],
  ];

  it.each(notObjects)(
    "refuses a row line that is %s, naming its line, and writes nothing",
    async (_label, line) => {
      const bad = withRows("bad-line", (itemId) => [row(itemId), line]);
      await refusedAt(bad.archive, bad.itemId, 2);

      // The witness: the same rows without the line restore.
      const { accepted } = await restoresWith("bad-line-witness", (itemId) => [
        row(itemId),
      ]);
      expect(accepted.rows_imported).toBe(1);
    },
  );

  it("refuses a row over 64 KiB, naming its line", async () => {
    const wide = (length: number) => ({ values: { text: "x".repeat(length) } });
    const limit = 65_536 - JSON.stringify({ text: "" }).length;
    const bad = withRows("wide", (itemId) => [row(itemId, wide(limit + 1))]);
    await refusedAt(bad.archive, bad.itemId, 1, "values");

    // The witness: a row at the limit restores.
    const { accepted } = await restoresWith("wide-witness", (itemId) => [
      row(itemId, wide(limit)),
    ]);
    expect(accepted.rows_imported).toBe(1);
  });

  it("refuses a row out of order or repeated, naming its line", async () => {
    const ordered = (itemId: string) =>
      [row(itemId), row(itemId)].sort((a, b) => (a.id < b.id ? -1 : 1));
    const reversed = withRows("reversed", (itemId) =>
      ordered(itemId).reverse(),
    );
    await refusedAt(reversed.archive, reversed.itemId, 2);
    const repeated = withRows("repeated", (itemId) => {
      const once = row(itemId);
      return [once, { ...once, values: { amount: 2 } }];
    });
    await refusedAt(repeated.archive, repeated.itemId, 2);

    // The witness: the same rows in order restore.
    const { accepted } = await restoresWith("ordered-witness", ordered);
    expect(accepted.rows_imported).toBe(2);
  });
});
