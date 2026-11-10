import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { HeldTables, Outcome } from "../../device/protocol.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import {
  movedClock,
  QUIET_SCHEDULE,
  quiet,
  runJob,
} from "../../utils/moved-clock.js";
import { clientsFor, everythingClient } from "../../utils/own-blob-server.js";
import { tapStream } from "../../utils/stream-tap.js";
import { requireBinary } from "./harness.js";

/**
 * The tables a working copy holds (`tables.md`, "Tables a device holds" and
 * the sections after it), against a fresh server and the real binary: which
 * tables a device holds, how it fills them whole up to the cap, how it
 * applies `rows.changed`, and the reads it answers from the copy.
 */

const HOUR_MS = 60 * 60 * 1000;

let server: FreshServer;
let working: MarfaClient;
let operator: MarfaClient;
let minter: MarfaClient;
let counter = 0;

beforeAll(async () => {
  server = await bootFreshServer("device-tables", QUIET_SCHEDULE);
  ({ working, operator } = clientsFor(server));
  minter = await everythingClient(server);
  await quiet(server, ["event-log-cleanup"]);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

const STEPS = {
  columns: {
    count: { type: "integer", adds_up: "sum" },
    note: { type: "string" },
    at: { type: "datetime", adds_up: "max" },
  },
};

async function tableType(
  tables: Record<string, unknown> = { steps: STEPS },
): Promise<string> {
  counter += 1;
  const id = `user.tables-${String(counter)}`;
  const made = await working.registerType({
    id,
    fields: { title: { type: "string" } },
    tables,
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return id;
}

async function itemOf(type: string): Promise<string> {
  const made = await working.createItem({
    type,
    properties: { title: "Steps" },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data.item.id;
}

type Operation = Record<string, unknown>;

async function write(
  item: string,
  operations: Operation[],
  table = "steps",
  client = working,
): Promise<{ id: string }[]> {
  const answer = await client.writeRows(item, table, { operations });
  expect(answer.status, JSON.stringify(answer.error)).toBe(200);
  return (answer.data as unknown as { results: { id: string }[] }).results;
}

/** `count` rows of `steps`, written in batches of 1000. */
async function filled(item: string, count: number, from = 0): Promise<void> {
  for (let at = 0; at < count; at += 1000) {
    const size = Math.min(1000, count - at);
    await write(
      item,
      Array.from({ length: size }, (_, row) => ({
        op: "put",
        values: { count: from + at + row },
      })),
    );
  }
}

interface Page {
  data: {
    id: string;
    values: Record<string, unknown>;
    updated_at: string;
    withheld?: string[];
  }[];
  next_cursor: string | null;
}

async function serverPage(
  item: string,
  query: Record<string, string> = {},
  client = working,
): Promise<Page> {
  const search = new URLSearchParams(query).toString();
  const answer = await client.rawRequest<Page>(
    `/items/${item}/tables/steps/rows${search === "" ? "" : `?${search}`}`,
  );
  expect(answer.status, JSON.stringify(answer.error)).toBe(200);
  return answer.data;
}

/** Every row of the table, by id, as the server answers it. */
async function serverRows(
  item: string,
  client = working,
): Promise<Page["data"]> {
  const rows: Page["data"] = [];
  let cursor: string | null = null;
  do {
    const page: Page = await serverPage(
      item,
      { limit: "1000", ...(cursor === null ? {} : { cursor }) },
      client,
    );
    rows.push(...page.data);
    cursor = page.next_cursor;
  } while (cursor !== null);
  return rows;
}

/** Every row the device answers, with whether each page came from the copy. */
async function deviceRows(
  device: CliDevice,
  item: string,
): Promise<{ rows: Page["data"]; held: boolean[] }> {
  const rows: Page["data"] = [];
  const held: boolean[] = [];
  let cursor: string | null = null;
  do {
    const page: Page & { held: boolean } = value(
      await device.tableRead<Page>([
        "list",
        item,
        "steps",
        "--limit",
        "1000",
        ...(cursor === null ? [] : ["--cursor", cursor]),
      ]),
    );
    rows.push(...page.data);
    held.push(page.held);
    cursor = page.next_cursor;
  } while (cursor !== null);
  return { rows, held };
}

function deviceFor(label: string, key = server.workingKey): CliDevice {
  counter += 1;
  return new CliDevice({
    binary: requireBinary(),
    store: newStore(`tables-${label}-${String(counter)}`),
    url: server.apiUrl,
    key,
  });
}

async function hydrated(
  types: string[],
  label: string,
  key = server.workingKey,
): Promise<CliDevice> {
  const device = deviceFor(label, key);
  value(await device.hydrate(types, "library"));
  return device;
}

function stateOf(
  held: HeldTables,
  item: string,
): HeldTables["tables"][number] | undefined {
  return held.tables.find((table) => table.item === item);
}

async function keyFor(
  types: Record<string, string>,
): Promise<{ id: string; key: string }> {
  counter += 1;
  const minted = await minter.createKey({
    label: `tables-${String(counter)}`,
    source: `tables-${String(counter)}`,
    type_permissions: types,
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  return { id: minted.data.id, key: minted.data.key };
}

const NAMED = {
  columns: { count: { type: "integer" }, ref: { type: "item" } },
};

async function note(title: string): Promise<string> {
  const made = await working.createItem({
    type: "core.note",
    properties: { title },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  return made.data.item.id;
}

async function purge(item: string): Promise<void> {
  expect((await working.deleteItem(item)).ok).toBe(true);
  const out = await working.purgeItem(item);
  expect(out.ok, JSON.stringify(out.error)).toBe(true);
}

/** Waits for the table of `item` that `device` holds to reach `state` with `rows`. */
async function reached(
  device: CliDevice,
  item: string,
  state: string,
  rows: number,
  what: string,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    const held = stateOf(value(await device.heldTables()), item);
    if (held?.state === state && held.rows === rows) return;
    if (Date.now() - started > 60_000) {
      expect(held, what).toMatchObject({ state, rows });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("which tables a device holds", () => {
  it("holds the table of each item of the type it names, and no table it was not asked to hold", async () => {
    const both = await tableType({ steps: STEPS, notes: STEPS });
    const other = await tableType();
    const chosen = await itemOf(both);
    const unchosen = await itemOf(other);
    await filled(chosen, 3);
    await write(chosen, [{ op: "put", values: { count: 1 } }], "notes");
    await filled(unchosen, 2);
    const device = await hydrated([both, other], "hold");

    const held = value(await device.holdTable(both, "steps"));
    expect(held.was_held).toBe(false);
    expect(held.fill).toMatchObject({ whole: 1, online: 0, unfilled: 0 });
    const tables = value(await device.heldTables());
    expect(tables.choices).toEqual([{ type: both, table: "steps" }]);
    // The server holds rows in the notes table and in the other type's
    // steps table, which the device was not asked to hold.
    expect(tables.tables).toEqual([
      { item: chosen, table: "steps", state: "whole", rows: 3 },
    ]);
    const unheld = value(
      await device.tableRead<Page>(["list", unchosen, "steps"]),
    );
    expect(unheld.held).toBe(false);
    expect(unheld.data).toHaveLength(2);
  });

  it("refuses to hold a table no type it names declares", async () => {
    const type = await tableType();
    await itemOf(type);
    const device = await hydrated([type], "unknown");
    const refused = await device.holdTable(type, "nothing");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("invalid");
      expect(refused.refusal.raw).toContain("nothing");
    }
    expect(value(await device.heldTables()).choices).toEqual([]);
  });
});

describe("how a device fills a table", () => {
  it("fills a table whole across pages, and answers it from the copy with the server out of reach", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    await filled(item, 2500);
    const own = await keyFor({ [type]: "write" });
    const device = await hydrated([type], "pages", own.key);
    const held = value(await device.holdTable(type, "steps"));
    expect(held.fill).toEqual({
      whole: 1,
      online: 0,
      unfilled: 0,
      pages: 3,
      rows: 2500,
    });
    const expected = await serverRows(item);

    const revoked = await minter.revokeKey(own.id);
    expect(revoked.status, JSON.stringify(revoked.error)).toBe(200);
    const read = await deviceRows(device, item);
    expect(read.held).toEqual([true, true, true]);
    expect(read.rows).toEqual(expected);
    const one = value(
      await device.tableRead<Page["data"][number]>([
        "get",
        item,
        "steps",
        expected[7]!.id,
      ]),
    );
    expect(one).toEqual({ ...expected[7], held: true });
    const totals = value(
      await device.tableRead<{
        row_count: number;
        totals: Record<string, unknown>;
      }>(["totals", item, "steps"]),
    );
    expect(totals).toEqual({
      row_count: 2500,
      totals: { count: { sum: (2499 * 2500) / 2 }, at: { max: null } },
      held: true,
    });
  });

  it("carries on a fill cut off at a page from the page after the last one it took", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    await filled(item, 3500);
    const device = await hydrated([type], "resume");
    await server.setFault("fail:table-rows-page=2");
    try {
      const cut = await device.holdTable(type, "steps");
      expect(cut.ok, "the second page failed, so the fill did not finish").toBe(
        false,
      );
    } finally {
      await server.clearFault();
    }
    expect(stateOf(value(await device.heldTables()), item)).toEqual({
      item,
      table: "steps",
      state: "filling",
      rows: 1000,
    });
    const meanwhile = value(
      await device.tableRead<Page>(["list", item, "steps"]),
    );
    expect(meanwhile.held).toBe(false);
    expect(meanwhile.data).toEqual((await serverPage(item)).data);

    const rest = value(await device.fillTables());
    expect(rest).toEqual({
      whole: 1,
      online: 0,
      unfilled: 0,
      pages: 3,
      rows: 2500,
    });
    expect(stateOf(value(await device.heldTables()), item)?.rows).toBe(3500);
    expect((await deviceRows(device, item)).rows).toEqual(
      await serverRows(item),
    );
  });

  it("expires its copy when its key narrows between two pages of a fill, and holds the rows withheld once it fills again", async () => {
    const type = await tableType({ steps: NAMED });
    const item = await itemOf(type);
    const named = await note("named");
    for (const from of [0, 1000]) {
      await write(
        item,
        Array.from({ length: from === 0 ? 1000 : 500 }, (_, at) => ({
          op: "put",
          values: { count: from + at, ref: named },
        })),
      );
    }
    const own = await keyFor({ [type]: "read", "core.note": "read" });
    const reader = new MarfaClient({ baseUrl: server.apiUrl, apiKey: own.key });
    const device = await hydrated([type], "narrowed", own.key);
    await server.setFault("fail:table-rows-page=2");
    try {
      expect((await device.holdTable(type, "steps")).ok).toBe(false);
    } finally {
      await server.clearFault();
    }
    expect(stateOf(value(await device.heldTables()), item)).toMatchObject({
      state: "filling",
      rows: 1000,
    });
    const narrowed = await minter.updateKey(own.id, {
      type_permissions: { [type]: "read" },
    });
    expect(narrowed.ok, JSON.stringify(narrowed.error)).toBe(true);

    const refused = await device.fillTables();
    expect(refused.ok, "the second page was read under the earlier reach").toBe(
      false,
    );
    if (!refused.ok) {
      expect(refused.refusal.code).toBe("copy_expired");
      expect(refused.refusal.raw).toContain("reach_changed");
    }
    expect(stateOf(value(await device.heldTables()), item)).toMatchObject({
      state: "owed",
      rows: 0,
    });
    value(await device.hydrate([type], "library"));
    value(await device.catchUp());
    const expected = await serverRows(item, reader);
    expect(expected).toHaveLength(1500);
    expect(expected.every((row) => row.withheld?.[0] === "ref")).toBe(true);
    expect((await deviceRows(device, item)).rows).toEqual(expected);
  }, 90_000);

  it("reads a table past the cap from the server, holding none of its rows, and holds it whole once a delete brings it within", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    await filled(item, 100_001);
    const device = await hydrated([type], "cap");
    const held = value(await device.holdTable(type, "steps"));
    expect(held.fill).toMatchObject({ whole: 0, online: 1, pages: 0, rows: 0 });
    expect(stateOf(value(await device.heldTables()), item)).toMatchObject({
      state: "online",
      rows: 0,
    });
    const online = value(await device.tableRead<Page>(["list", item, "steps"]));
    expect(online.held).toBe(false);
    expect(online.data).toHaveLength(100);

    const first = (await serverPage(item, { limit: "1" })).data[0]!;
    await write(item, [{ op: "delete", id: first.id }]);
    const caught = value(await device.catchUp());
    expect(caught.tables).toMatchObject({ whole: 1, online: 0, rows: 100_000 });
    expect(stateOf(value(await device.heldTables()), item)).toMatchObject({
      state: "whole",
      rows: 100_000,
    });
    const whole = value(await device.tableRead<Page>(["list", item, "steps"]));
    expect(whole.held).toBe(true);

    await write(item, [{ op: "put", values: { count: -1 } }]);
    value(await device.catchUp());
    expect(stateOf(value(await device.heldTables()), item)).toMatchObject({
      state: "online",
      rows: 0,
    });
  }, 240_000);

  it("fills a table again each time a follow sees it come back within the cap", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    await filled(item, 100_001);
    const device = await hydrated([type], "cap-follow");
    expect(value(await device.holdTable(type, "steps")).fill).toMatchObject({
      online: 1,
    });
    const follow = device.holdFollow(240);
    const reader = device.reopen({ reader: true });
    try {
      for (const round of [1, 2]) {
        const first = (await serverPage(item, { limit: "1" })).data[0]!;
        await write(item, [{ op: "delete", id: first.id }]);
        const at = `round ${String(round)}`;
        await reached(reader, item, "whole", 100_000, `${at}: within`);
        await write(item, [{ op: "put", values: { count: -round } }]);
        await reached(reader, item, "online", 0, `${at}: past`);
      }
    } finally {
      await follow.stop();
    }
  }, 300_000);
});

describe("applying rows.changed", () => {
  it("applies each rows.changed a follow reads, rows put, patched and deleted", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const device = await hydrated([type], "follow");
    value(await device.holdTable(type, "steps"));
    const follow = device.holdFollow(60);
    const reader = device.reopen({ reader: true });
    const settled = async (what: string) => {
      const expected = await serverRows(item);
      const started = Date.now();
      for (;;) {
        const read = await reader.tableRead<Page>([
          "list",
          item,
          "steps",
          "--limit",
          "1000",
        ]);
        if (
          read.ok &&
          read.value.held &&
          JSON.stringify(read.value.data) === JSON.stringify(expected)
        ) {
          return;
        }
        if (Date.now() - started > 20_000) {
          expect(read.ok ? read.value.data : read, what).toEqual(expected);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    try {
      const [kept, gone] = await write(item, [
        { op: "put", values: { count: 1, note: "first" } },
        { op: "put", values: { count: 2 } },
      ]);
      await settled("the rows put");
      await write(item, [
        { op: "patch", id: kept!.id, values: { note: "patched" } },
      ]);
      await settled("the row patched");
      await write(item, [{ op: "delete", id: gone!.id }]);
      await settled("the row deleted");
      // An item that comes into the copy while the follow runs has its table filled too.
      const later = await itemOf(type);
      await write(later, [{ op: "put", values: { count: 9 } }]);
      const started = Date.now();
      for (;;) {
        const held = value(await reader.heldTables());
        if (
          stateOf(held, later)?.state === "whole" &&
          stateOf(held, later)?.rows === 1
        )
          break;
        if (Date.now() - started > 20_000) {
          expect(stateOf(held, later)).toMatchObject({
            state: "whole",
            rows: 1,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      await follow.stop();
    }
  }, 90_000);

  it("reads the rows a rows.changed names without values, and removes those the server no longer holds", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const device = await hydrated([type], "ids");
    value(await device.holdTable(type, "steps"));
    const tap = await tapStream(server.apiUrl, server.workingKey);
    try {
      await tap.until(
        (seen) => seen.some((e) => e.event === "stream_live"),
        "the stream going live",
      );
      const long = "x".repeat(1000);
      const put = await write(
        item,
        Array.from({ length: 100 }, (_, at) => ({
          op: "put",
          values: { count: at, note: long },
        })),
      );
      await write(
        item,
        put.slice(0, 10).map((row) => ({ op: "delete", id: row.id })),
      );
      const seen = await tap.until(
        (got) => got.filter((e) => e.event === "rows.changed").length >= 2,
        "both batches on the stream",
      );
      const batches = seen.filter((e) => e.event === "rows.changed");
      expect(
        (batches[0]!.data as { values_included?: boolean }).values_included,
      ).toBe(false);
      // With the delete's own event hidden, only the read of the first
      // batch's rows can take the ten out.
      await server.setFault(`hide:event=${batches[1]!.id!}`);
      try {
        value(await device.catchUp());
      } finally {
        await server.clearFault();
      }
    } finally {
      await tap.close();
    }
    const expected = await serverRows(item);
    expect(expected).toHaveLength(90);
    expect((await deviceRows(device, item)).rows).toEqual(expected);
  });

  it("holds a row without the value withheld from its key, and answers it withheld", async () => {
    const type = await tableType({
      steps: { columns: { count: { type: "integer" }, ref: { type: "item" } } },
    });
    const item = await itemOf(type);
    const secret = await working.createItem({
      type: "core.note",
      properties: { title: "secret" },
    } as never);
    expect(secret.status).toBe(201);
    await write(item, [
      { op: "put", values: { count: 1, ref: secret.data.item.id } },
    ]);
    const narrow = await keyFor({ [type]: "read" });
    const reader = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: narrow.key,
    });
    const device = await hydrated([type], "withheld", narrow.key);
    value(await device.holdTable(type, "steps"));
    await write(item, [
      { op: "put", values: { count: 2, ref: secret.data.item.id } },
    ]);
    value(await device.catchUp());
    const expected = await serverRows(item, reader);
    expect(expected.map((row) => row.withheld)).toEqual([["ref"], ["ref"]]);
    // The witness: a key that reads the note sees the reference.
    expect((await serverRows(item)).map((row) => row.values.ref)).toEqual([
      secret.data.item.id,
      secret.data.item.id,
    ]);
    const read = await deviceRows(device, item);
    expect(read.held).toEqual([true]);
    expect(read.rows).toEqual(expected);
  });

  it("answers a row naming a purged item as the server does, withheld unless its key reads every type", async () => {
    const type = await tableType({ steps: NAMED });
    const item = await itemOf(type);
    const named = await note("purged later");
    await write(item, [
      { op: "put", values: { count: 1, ref: named } },
      { op: "put", values: { count: 2 } },
    ]);
    const narrow = await keyFor({ [type]: "read", "core.note": "read" });
    const reader = new MarfaClient({
      baseUrl: server.apiUrl,
      apiKey: narrow.key,
    });
    // The note is outside both slices.
    const narrowDevice = await hydrated([type], "ref-narrow", narrow.key);
    const everyDevice = await hydrated([type], "ref-every");
    for (const device of [narrowDevice, everyDevice]) {
      value(await device.holdTable(type, "steps"));
      const before = await deviceRows(device, item);
      expect(
        before.rows.find((row) => row.values.count === 1)?.values.ref,
      ).toBe(named);
    }
    await purge(named);
    for (const device of [narrowDevice, everyDevice]) {
      value(await device.catchUp());
    }
    const narrowed = await serverRows(item, reader);
    expect(narrowed.find((row) => row.values.count === 1)?.withheld).toEqual([
      "ref",
    ]);
    const narrowRead = await deviceRows(narrowDevice, item);
    expect(narrowRead.held).toEqual([true]);
    expect(narrowRead.rows).toEqual(narrowed);
    const every = await serverRows(item);
    expect(every.find((row) => row.values.count === 1)?.values.ref).toBe(named);
    expect((await deviceRows(everyDevice, item)).rows).toEqual(every);
  });

  it("carries on past a rows.changed without values whose item is purged before it reads the rows", async () => {
    const type = await tableType();
    const purged = await itemOf(type);
    const kept = await itemOf(type);
    const device = await hydrated([type], "ids-purged");
    value(await device.holdTable(type, "steps"));
    const long = "x".repeat(1000);
    await write(
      purged,
      Array.from({ length: 100 }, (_, at) => ({
        op: "put",
        values: { count: at, note: long },
      })),
    );
    await purge(purged);
    await write(kept, [{ op: "put", values: { count: 7 } }]);

    for (const round of ["first", "second"]) {
      const caught = await device.catchUp();
      expect(caught.ok, `${round} catch-up: ${JSON.stringify(caught)}`).toBe(
        true,
      );
    }
    expect(value(await device.heldTables()).tables).toEqual([
      { item: kept, table: "steps", state: "whole", rows: 1 },
    ]);
    expect((await deviceRows(device, kept)).rows).toEqual(
      await serverRows(kept),
    );
  });

  it("removes the rows of a table it lets go of, and of an item that is purged", async () => {
    const type = await tableType();
    const kept = await itemOf(type);
    const purged = await itemOf(type);
    await filled(kept, 2);
    await filled(purged, 3);
    const device = await hydrated([type], "gone");
    value(await device.holdTable(type, "steps"));
    expect(stateOf(value(await device.heldTables()), purged)).toMatchObject({
      state: "whole",
      rows: 3,
    });
    expect((await working.deleteItem(purged)).ok).toBe(true);
    const out = await working.purgeItem(purged);
    expect(out.ok, JSON.stringify(out.error)).toBe(true);
    value(await device.catchUp());
    expect(value(await device.heldTables()).tables).toEqual([
      { item: kept, table: "steps", state: "whole", rows: 2 },
    ]);

    expect(value(await device.letGoTable(type, "steps")).was_held).toBe(true);
    expect(value(await device.heldTables())).toEqual({
      choices: [],
      tables: [],
    });
    const read = value(await device.tableRead<Page>(["list", kept, "steps"]));
    expect(read.held).toBe(false);
    expect(read.data).toHaveLength(2);
  });

  it("removes the rows of a table its type no longer declares", async () => {
    const type = await tableType({ steps: STEPS, extra: STEPS });
    const item = await itemOf(type);
    await write(item, [{ op: "put", values: { count: 1 } }], "extra");
    const device = await hydrated([type], "removed");
    value(await device.holdTable(type, "extra"));
    expect(stateOf(value(await device.heldTables()), item)).toMatchObject({
      table: "extra",
      state: "whole",
      rows: 1,
    });
    const changed = await working.replaceType(
      type,
      {
        id: type,
        fields: { title: { type: "string" } },
        tables: { steps: STEPS },
      },
      true,
    );
    expect(changed.status, JSON.stringify(changed.error)).toBe(200);
    value(await device.catchUp());
    expect(value(await device.heldTables()).tables).toEqual([]);
  });
});

describe("reading a table on a device", () => {
  let item: string;
  let device: CliDevice;

  beforeAll(async () => {
    const type = await tableType();
    item = await itemOf(type);
    await write(
      item,
      Array.from({ length: 30 }, (_, at) => ({
        op: "put",
        values: {
          ...(at % 4 === 0 ? {} : { count: at % 7 }),
          ...(at % 3 === 0
            ? { note: `note ${String.fromCharCode(97 + (at % 5))}` }
            : {}),
          ...(at % 5 === 0
            ? {}
            : {
                at: `2026-0${String(1 + (at % 9))}-01T0${String(at % 10)}:00:00Z`,
              }),
        },
      })),
    );
    device = await hydrated([type], "reads");
    value(await device.holdTable(type, "steps"));
  });

  it("pages, filters, sorts and totals from the copy as the server does", async () => {
    const asked: Record<string, string>[] = [
      { limit: "7" },
      { limit: "4", sort: "values.count", direction: "desc" },
      { limit: "6", sort: "values.note" },
      { limit: "5", sort: "updated_at", direction: "desc" },
      { limit: "8", sort: "values.at" },
      { filter: "values.count gt 3" },
      { filter: 'values.note contains "a" OR values.count eq 2' },
      { filter: "values.at not_exists", sort: "values.count" },
      { filter: 'values.at gte "2026-05-01T00:00:00Z"' },
    ];
    for (const query of asked) {
      const flags = Object.entries(query).flatMap(([name, given]) => [
        `--${name}`,
        given,
      ]);
      const walked: Page["data"] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Page & { held: boolean } = value(
          await device.tableRead<Page>([
            "list",
            item,
            "steps",
            ...flags,
            ...(cursor === null ? [] : ["--cursor", cursor]),
          ]),
        );
        expect(page.held).toBe(true);
        walked.push(...page.data);
        cursor = page.next_cursor;
        pages += 1;
      } while (cursor !== null && pages < 50);
      const expected: Page["data"] = [];
      let next: string | null = null;
      do {
        const page: Page = await serverPage(item, {
          ...query,
          ...(next === null ? {} : { cursor: next }),
        });
        expected.push(...page.data);
        next = page.next_cursor;
      } while (next !== null);
      expect(walked, JSON.stringify(query)).toEqual(expected);
    }
    for (const filter of [
      undefined,
      "values.count lt 4",
      'values.note starts_with "note b"',
    ]) {
      const local = value(
        await device.tableRead<Record<string, unknown>>([
          "totals",
          item,
          "steps",
          ...(filter === undefined ? [] : ["--filter", filter]),
        ]),
      );
      const remote = await working.rawRequest<Record<string, unknown>>(
        `/items/${item}/tables/steps/totals${filter === undefined ? "" : `?filter=${encodeURIComponent(filter)}`}`,
      );
      expect(remote.status).toBe(200);
      expect(local, filter).toEqual({ ...remote.data, held: true });
    }
  });

  it("refuses from the copy what the server refuses", async () => {
    const refused: [string, string[], Record<string, string>][] = [
      ["limit", ["--limit", "0"], { limit: "0" }],
      ["limit", ["--limit", "1001"], { limit: "1001" }],
      [
        "filter",
        ["--filter", "values.nothing eq 1"],
        { filter: "values.nothing eq 1" },
      ],
      [
        "filter",
        ["--filter", "properties.title eq 1"],
        { filter: "properties.title eq 1" },
      ],
      ["sort", ["--sort", "values.nothing"], { sort: "values.nothing" }],
      ["cursor", ["--cursor", "nonsense"], { cursor: "nonsense" }],
    ];
    for (const [field, flags, query] of refused) {
      const remote = await working.rawRequest(
        `/items/${item}/tables/steps/rows?${new URLSearchParams(query).toString()}`,
      );
      expect(remote.status, `the server refuses ${field}`).toBe(400);
      const local = await device.tableRead(["list", item, "steps", ...flags]);
      expect(local.ok, field).toBe(false);
      if (!local.ok) {
        expect(local.refusal.code, local.refusal.raw).toBe("invalid");
        expect(local.refusal.raw).toContain(field);
      }
    }
  });

  it("answers the table of an item in the bin from the server, and from the copy once it is back", async () => {
    const type = await tableType();
    const binned = await itemOf(type);
    await filled(binned, 4);
    const own = await hydrated([type], "bin");
    value(await own.holdTable(type, "steps"));
    expect((await working.deleteItem(binned)).ok).toBe(true);
    value(await own.catchUp());
    const read = await own.tableRead<Page>(["list", binned, "steps"]);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.refusal.raw).toContain("item_not_found");
    expect(stateOf(value(await own.heldTables()), binned)).toMatchObject({
      state: "whole",
      rows: 4,
    });
    expect((await working.restoreItem(binned)).ok).toBe(true);
    value(await own.catchUp());
    const back = value(await own.tableRead<Page>(["list", binned, "steps"]));
    expect(back.held).toBe(true);
    expect(back.data).toEqual((await serverPage(binned)).data);
  });
});

describe("a gap in the stream", () => {
  it("fills its tables again when its cursor ages out, with the rows changed meanwhile", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    await filled(item, 5);
    const device = await hydrated([type], "gap");
    value(await device.holdTable(type, "steps"));
    const config = (await operator.getConfig()).data as Record<string, unknown>;
    const set = await operator.updateConfig({
      ...config,
      event_log_retention_hours: 1,
    });
    expect(set.status, JSON.stringify(set.error)).toBe(200);
    const first = (await serverPage(item, { limit: "1" })).data[0]!;
    await write(item, [
      { op: "delete", id: first.id },
      { op: "put", values: { count: 50 } },
    ]);
    await movedClock(server).advance(2 * HOUR_MS);
    await write(item, [{ op: "put", values: { count: 51 } }]);
    // The sweep keeps what the webhook sender has not passed, which it does
    // soon after each write.
    let deleted = 0;
    for (let tries = 0; deleted < 3 && tries < 50; tries += 1) {
      const swept = await runJob(server, "event-log-cleanup");
      expect(swept.outcome).toBe("ok");
      deleted += (swept.result as { deleted: number }).deleted;
      if (deleted < 3) await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const expired = await device.catchUp();
    expect(expired.ok, "the log no longer holds the copy's cursor").toBe(false);
    expect(stateOf(value(await device.heldTables()), item)).toMatchObject({
      state: "owed",
      rows: 0,
    });
    value(await device.hydrate([type], "library"));
    value(await device.catchUp());
    const read = await deviceRows(device, item);
    expect(read.held).toEqual([true]);
    expect(read.rows).toEqual(await serverRows(item));
  });
});
