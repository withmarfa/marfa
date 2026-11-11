import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import { BindingDevice } from "../../device/binding-adapter.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type {
  DrainReport,
  HeldTables,
  Outcome,
  QueuedWrite,
} from "../../device/protocol.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { QUIET_SCHEDULE, quiet } from "../../utils/moved-clock.js";
import { clientsFor, everythingClient } from "../../utils/own-blob-server.js";
import { requireBinary, requireModule } from "./harness.js";

/**
 * Row writes on a working copy (`device.md`, "Writing a table on a device",
 * and `queue-and-verdicts.md`, "Row writes"), against a fresh server and the
 * real binary: what a write shows at once, how a drain sends it and what its
 * verdict does to the rows the copy holds.
 */

let server: FreshServer;
let working: MarfaClient;
let minter: MarfaClient;
let counter = 0;
const bindings: BindingDevice[] = [];

beforeAll(async () => {
  server = await bootFreshServer("device-table-writes", QUIET_SCHEDULE);
  ({ working } = clientsFor(server));
  minter = await everythingClient(server);
  await quiet(server, ["event-log-cleanup"]);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  for (const binding of bindings) await binding.close();
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

function refused<T>(answer: Outcome<T>): { code: string; raw: string } {
  expect(answer.ok, JSON.stringify(answer)).toBe(false);
  if (answer.ok) throw new Error("the write was taken");
  return answer.refusal;
}

const STEPS = {
  columns: {
    count: { type: "integer" },
    note: { type: "string" },
    ref: { type: "item" },
  },
};

async function tableType(): Promise<string> {
  counter += 1;
  const id = `user.table-writes-${String(counter)}`;
  const made = await working.registerType({
    id,
    fields: { title: { type: "string" } },
    tables: { steps: STEPS },
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

interface Written {
  batch: string | null;
  results: { id: string; outcome: string }[];
}

async function write(
  item: string,
  operations: Operation[],
  client = working,
): Promise<Written> {
  const answer = await client.writeRows(item, "steps", { operations });
  expect(answer.status, JSON.stringify(answer.error)).toBe(200);
  return answer.data as unknown as Written;
}

interface Row {
  id: string;
  values: Record<string, unknown>;
  updated_at: string;
  withheld?: string[];
}

interface Page {
  data: Row[];
  next_cursor: string | null;
  held: boolean;
}

async function serverRows(item: string): Promise<Record<string, unknown>> {
  const answer = await working.rawRequest<{ data: Row[] }>(
    `/items/${item}/tables/steps/rows?limit=1000`,
  );
  expect(answer.status, JSON.stringify(answer.error)).toBe(200);
  return Object.fromEntries(
    answer.data.data.map((row) => [row.id, row.values]),
  );
}

async function devicePage(device: CliDevice, item: string): Promise<Page> {
  return value(
    await device.tableRead<Page>(["list", item, "steps", "--limit", "1000"]),
  );
}

async function deviceRows(
  device: CliDevice,
  item: string,
): Promise<Record<string, unknown>> {
  const page = await devicePage(device, item);
  return Object.fromEntries(page.data.map((row) => [row.id, row.values]));
}

function deviceFor(label: string, key = server.workingKey): CliDevice {
  counter += 1;
  return new CliDevice({
    binary: requireBinary(),
    store: newStore(`table-writes-${label}-${String(counter)}`),
    url: server.apiUrl,
    key,
  });
}

/** A device holding the `steps` table of every item of `type`, whole. */
async function holding(
  type: string,
  label: string,
  key = server.workingKey,
): Promise<CliDevice> {
  const device = deviceFor(label, key);
  value(await device.hydrate([type], "library"));
  value(await device.holdTable(type, "steps"));
  return device;
}

function stateOf(held: HeldTables, item: string): string | undefined {
  return held.tables.find((table) => table.item === item)?.state;
}

async function queued(device: CliDevice, id: string): Promise<QueuedWrite> {
  const found = value(await device.queue()).find((write) => write.id === id);
  expect(found, `the write ${id} left the queue`).toBeDefined();
  return found!;
}

function verdictOf(report: DrainReport, id: string): string | null {
  const entry = report.verdicts.find((verdict) => verdict.id === id);
  expect(entry, `the drain told nothing of ${id}`).toBeDefined();
  return entry!.verdict;
}

async function keyFor(
  types: Record<string, string>,
): Promise<{ id: string; key: string }> {
  counter += 1;
  const minted = await minter.createKey({
    label: `table-writes-${String(counter)}`,
    source: `table-writes-${String(counter)}`,
    type_permissions: types,
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  return { id: minted.data.id, key: minted.data.key };
}

/** A fault gate a debug build waits at, by reach, until it is released. */
class Gate {
  readonly path: string;

  constructor(
    base: string,
    readonly fault: string,
  ) {
    this.path = join(base, fault);
  }

  get env(): NodeJS.ProcessEnv {
    return { MARFA_TEST_FAULT: `${this.fault}=${this.path}` };
  }

  reached(): number {
    try {
      return Number(readFileSync(`${this.path}.ready`, "utf8").trim()) || 0;
    } catch {
      return 0;
    }
  }

  release(through: number | "all"): void {
    const next = `${this.path}.release.next`;
    writeFileSync(next, String(through));
    renameSync(next, `${this.path}.release`);
  }
}

async function until(
  check: () => Promise<boolean> | boolean,
  what: string,
): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > 30_000) throw new Error(`never: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("a write the copy shows at once", () => {
  it("queues a write to a table it holds whole and answers it from the copy at once, before any drain", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const [kept, gone] = [uuidv7(), uuidv7()];
    await write(item, [
      { op: "put", id: kept, values: { count: 1, note: "a" } },
      { op: "put", id: gone, values: { count: 2 } },
    ]);
    const device = await holding(type, "shown");
    const added = uuidv7();
    const queuedWrite = value(
      await device.writeRows(item, "steps", [
        { op: "patch", id: kept, values: { note: "b" } },
        { op: "delete", id: gone },
        { op: "put", id: added, values: { count: 3, note: "first" } },
        { op: "patch", id: added, values: { note: null } },
      ]),
    );
    expect(queuedWrite).toMatchObject({
      kind: "write_rows",
      item_id: item,
      table: "steps",
      verdict: null,
    });
    expect(value(await device.queue()).map((one) => one.id)).toEqual([
      queuedWrite.id,
    ]);

    const page = await devicePage(device, item);
    expect(page.held).toBe(true);
    expect(
      Object.fromEntries(page.data.map((row) => [row.id, row.values])),
    ).toEqual({ [kept]: { count: 1, note: "b" }, [added]: { count: 3 } });
    for (const row of page.data) {
      expect(row.updated_at).toBe(queuedWrite.queued_at);
    }
    expect(await serverRows(item)).toEqual({
      [kept]: { count: 1, note: "a" },
      [gone]: { count: 2 },
    });

    const report = value(await device.drain());
    expect(verdictOf(report, queuedWrite.id)).toBe("accepted");
    expect(await serverRows(item)).toEqual({
      [kept]: { count: 1, note: "b" },
      [added]: { count: 3 },
    });
  });

  it("refuses a write it can judge from the copy as the server would, queueing nothing", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    const note = await working.createItem({
      type: "core.note",
      properties: { title: "Named" },
    } as never);
    expect(note.status, JSON.stringify(note.error)).toBe(201);
    await write(item, [
      { op: "put", id: row, values: { count: 1, ref: note.data.item.id } },
    ]);
    const narrow = await keyFor({ [type]: "write" });
    const device = await holding(type, "judged", narrow.key);
    const held = await devicePage(device, item);
    expect(held.data[0]?.withheld).toEqual(["ref"]);

    const other = await tableType();
    const unheld = await itemOf(other);
    const notHeld = refused(
      await device.writeRows(unheld, "steps", [
        { op: "put", values: { count: 1 } },
      ]),
    );
    expect(notHeld.code).toBe("not_found");
    expect(notHeld.raw).toContain("item_not_found");

    const undeclared = refused(
      await device.writeRows(item, "nothing", [
        { op: "put", values: { count: 1 } },
      ]),
    );
    expect(undeclared.code).toBe("not_found");
    expect(undeclared.raw).toContain("table_not_found");

    for (const [operations, named] of [
      [[], "operations"],
      [[{ op: "move", id: row }], "operations.0.op"],
      [[{ op: "put", id: "not-a-row" }], "operations.0.id"],
      [[{ op: "delete", id: row, values: {} }], "operations.0.values"],
      [
        [{ op: "patch", id: row, version: 1, values: {} }],
        "operations.0.version",
      ],
      [[{ op: "put", values: "count" }], "operations.0.values"],
      [
        [
          { op: "put", values: { count: 1 } },
          { op: "put", values: { other: 1 } },
        ],
        "operations.1.values.other",
      ],
      [[{ op: "put", values: { count: "many" } }], "operations.0.values.count"],
      [
        Array.from({ length: 1001 }, () => ({ op: "put", values: {} })),
        "operations",
      ],
    ] as [Operation[], string][]) {
      const judged = refused(await device.writeRows(item, "steps", operations));
      expect(judged.code, JSON.stringify(operations).slice(0, 80)).toBe(
        "invalid",
      );
      expect(judged.raw).toContain(named);
    }

    const withheld = refused(
      await device.writeRows(item, "steps", [
        { op: "patch", id: row, values: { ref: null } },
      ]),
    );
    expect(withheld.code).toBe("forbidden");
    expect(withheld.raw).toContain("ref");
    expect(withheld.raw).toContain("operation 0");

    expect(value(await device.queue())).toEqual([]);
    expect(Object.values(await deviceRows(device, item))).toEqual([
      { count: 1 },
    ]);
  });
});

describe("a write laid over what the server sends", () => {
  it("lays a waiting write back over each rows.changed it applies beneath it", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    await write(item, [
      { op: "put", id: row, values: { count: 1, note: "a" } },
    ]);
    const device = await holding(type, "over-event");
    const mine = value(
      await device.writeRows(item, "steps", [
        { op: "patch", id: row, values: { note: "mine" } },
      ]),
    );

    await write(item, [{ op: "patch", id: row, values: { count: 2 } }]);
    value(await device.catchUp());
    expect(await deviceRows(device, item)).toEqual({
      [row]: { count: 2, note: "mine" },
    });

    // Past the event's byte cap, so the device reads the rows it names.
    const long = "x".repeat(1_000);
    await write(item, [
      { op: "patch", id: row, values: { count: 3 } },
      ...Array.from({ length: 70 }, () => ({
        op: "put",
        values: { note: long },
      })),
    ]);
    value(await device.catchUp());
    const read = await deviceRows(device, item);
    expect(read[row]).toEqual({ count: 3, note: "mine" });
    expect(Object.keys(read)).toHaveLength(71);

    expect(verdictOf(value(await device.drain()), mine.id)).toBe("accepted");
    value(await device.catchUp());
    expect((await deviceRows(device, item))[row]).toEqual({
      count: 3,
      note: "mine",
    });
    expect((await serverRows(item))[row]).toEqual({ count: 3, note: "mine" });
  });

  it("lays writes queued before it held a table over the rows once the table fills", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    await write(item, [
      { op: "put", id: row, values: { count: 1, note: "a" } },
    ]);
    const device = deviceFor("over-fill");
    value(await device.hydrate([type], "library"));
    value(
      await device.writeRows(item, "steps", [
        { op: "patch", id: row, values: { note: "mine" } },
      ]),
    );
    expect(value(await device.holdTable(type, "steps")).fill).toMatchObject({
      whole: 1,
    });
    const page = await devicePage(device, item);
    expect(page.held).toBe(true);
    expect(
      Object.fromEntries(page.data.map((one) => [one.id, one.values])),
    ).toEqual({ [row]: { count: 1, note: "mine" } });
  });

  it("queues a write to a table it does not hold, or holds past the cap, without a copy, and reads the table from the server", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    await write(item, [{ op: "put", id: row, values: { count: 1 } }]);
    const unheld = deviceFor("unheld");
    value(await unheld.hydrate([type], "library"));
    const queuedWrite = value(
      await unheld.writeRows(item, "steps", [
        { op: "patch", id: row, values: { count: 2 } },
      ]),
    );
    const before = await devicePage(unheld, item);
    expect(before.held).toBe(false);
    expect(before.data.map((one) => one.values)).toEqual([{ count: 1 }]);
    expect(value(await unheld.heldTables()).tables).toEqual([]);
    expect(verdictOf(value(await unheld.drain()), queuedWrite.id)).toBe(
      "accepted",
    );
    expect(await serverRows(item)).toEqual({ [row]: { count: 2 } });

    const big = await itemOf(type);
    for (let at = 0; at < 100_001; at += 1000) {
      await write(
        big,
        Array.from({ length: Math.min(1000, 100_001 - at) }, () => ({
          op: "put",
          values: { count: 0 },
        })),
      );
    }
    const past = await holding(type, "past-cap");
    expect(stateOf(value(await past.heldTables()), big)).toBe("online");
    const added = uuidv7();
    const online = value(
      await past.writeRows(big, "steps", [
        { op: "put", id: added, values: { count: 9 } },
      ]),
    );
    expect(stateOf(value(await past.heldTables()), big)).toBe("online");
    const one = await past.tableRead<Row>(["get", big, "steps", added]);
    expect(one.ok).toBe(false);
    expect(verdictOf(value(await past.drain()), online.id)).toBe("accepted");
    const after = value(
      await past.tableRead<Row>(["get", big, "steps", added]),
    );
    expect(after).toMatchObject({ values: { count: 9 }, held: false });
  });

  it("holds the table of an item it created offline whole, shows the rows written to it, and sends them once the create is accepted", async () => {
    const type = await tableType();
    await itemOf(type);
    const device = await holding(type, "own-item");
    const created = value(
      await device.create({ type, properties: { title: "Offline" } }),
    );
    const item = created.item_id!;
    value(await device.fillTables());
    const held = value(await device.heldTables());
    expect(held.tables.find((table) => table.item === item)).toMatchObject({
      state: "whole",
      rows: 0,
    });
    const row = uuidv7();
    const rows = value(
      await device.writeRows(item, "steps", [
        { op: "put", id: row, values: { count: 1 } },
      ]),
    );
    expect(rows.depends_on).toEqual([created.id]);
    const page = await devicePage(device, item);
    expect(page.held).toBe(true);
    expect(page.data.map((one) => one.values)).toEqual([{ count: 1 }]);

    const report = value(await device.drain());
    expect(verdictOf(report, created.id)).toBe("accepted");
    expect(verdictOf(report, rows.id)).toBe("accepted");
    expect(await serverRows(item)).toEqual({ [row]: { count: 1 } });
  });
});

describe("what a verdict does to the rows a copy holds", () => {
  it("keeps an accepted write over a rows.changed the server sent before it and applied after its answer", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    await write(item, [
      { op: "put", id: row, values: { count: 1, note: "a" } },
    ]);
    counter += 1;
    const store = newStore(`table-writes-kept-${String(counter)}`);
    const gate = new Gate(dirname(store), "gate-rows-event");
    const device = await BindingDevice.start({
      module: requireModule(),
      store,
      url: server.apiUrl,
      key: server.workingKey,
      env: gate.env,
    });
    bindings.push(device);
    value(await device.hydrate([type], "library"));
    value(await device.call("holdTable", type, "steps"));
    const shown = async (): Promise<Record<string, unknown>> => {
      const page = value(
        await device.call<Page>("tableRows", item, "steps", { limit: 1000 }),
      );
      expect(page.held).toBe(true);
      return Object.fromEntries(page.data.map((one) => [one.id, one.values]));
    };
    const follow = await device.follow();
    try {
      await write(item, [{ op: "patch", id: row, values: { count: 5 } }]);
      await until(() => gate.reached() === 1, "the follow reaching the event");
      const mine = value(
        await device.call<QueuedWrite>("writeRows", item, "steps", [
          { op: "patch", id: row, values: { note: "mine" } },
        ]),
      );
      // The binding reads a verdict into its parts.
      const report = value(
        await device.call<{
          verdicts: { id: string; verdict: { verdict: string } | null }[];
        }>("drain"),
      );
      expect(
        report.verdicts.find((entry) => entry.id === mine.id)?.verdict?.verdict,
      ).toBe("accepted");
      expect(await shown()).toEqual({ [row]: { count: 1, note: "mine" } });

      gate.release(1);
      await until(
        async () => (await shown())[row] !== undefined && gate.reached() >= 2,
        "the follow taking the earlier event and reaching its own",
      );
      expect(await shown()).toEqual({ [row]: { count: 5, note: "mine" } });
      gate.release("all");
      await until(async () => {
        const held = value(await device.call<QueuedWrite[]>("queue"));
        return held.length === 1;
      }, "the queue holding the answered write");
      expect(await shown()).toEqual({ [row]: { count: 5, note: "mine" } });
    } finally {
      gate.release("all");
      expect(await follow.stop()).toBeNull();
    }
  });

  it("holds a row an accepted write left unchanged as the write left it", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    await write(item, [
      { op: "put", id: row, values: { count: 1, note: "a" } },
    ]);
    const device = await holding(type, "unchanged");
    await write(item, [{ op: "patch", id: row, values: { note: "same" } }]);
    const mine = value(
      await device.writeRows(item, "steps", [
        { op: "patch", id: row, values: { note: "same" } },
      ]),
    );
    expect(verdictOf(value(await device.drain()), mine.id)).toBe("accepted");
    const answered = await queued(device, mine.id);
    expect(JSON.parse(answered.answer!)).toMatchObject({
      batch: null,
      results: [{ id: row, outcome: "unchanged" }],
    });
    expect(await deviceRows(device, item)).toEqual({
      [row]: { count: 1, note: "same" },
    });
  });

  it("shows the server's row once a write is refused, and keeps the write in the queue with its body", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    await write(item, [
      { op: "put", id: row, values: { count: 1, note: "a" } },
    ]);
    const device = await holding(type, "refused");
    const mine = value(
      await device.writeRows(item, "steps", [
        { op: "patch", id: row, values: { note: "mine" } },
      ]),
    );
    expect(await deviceRows(device, item)).toEqual({
      [row]: { count: 1, note: "mine" },
    });
    await write(item, [{ op: "delete", id: row }]);

    expect(verdictOf(value(await device.drain()), mine.id)).toBe("refused");
    expect(await deviceRows(device, item)).toEqual({
      [row]: { count: 1, note: "a" },
    });
    const kept = await queued(device, mine.id);
    expect(kept.refusal).toMatchObject({ code: "row_not_found" });
    expect(JSON.parse(kept.answer!)).toMatchObject({
      error: { code: "row_not_found", details: { operation: 0 } },
    });
    expect(kept.body).toEqual({
      operations: [{ op: "patch", id: row, values: { note: "mine" } }],
    });
    value(await device.catchUp());
    expect(await deviceRows(device, item)).toEqual({});
  });

  it("records a write conflicted where it replaced a value the copy had not shown, and the value it replaced stays in the batch's change log", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const [first, second, third] = [uuidv7(), uuidv7(), uuidv7()];
    await write(item, [
      { op: "put", id: first, values: { count: 1, note: "a" } },
      { op: "put", id: second, values: { count: 2 } },
      { op: "put", id: third, values: { count: 3 } },
    ]);
    const device = await holding(type, "conflicted");
    const edits = [
      value(
        await device.writeRows(item, "steps", [
          { op: "patch", id: first, values: { note: "offline" } },
        ]),
      ),
      value(
        await device.writeRows(item, "steps", [
          { op: "patch", id: second, values: { count: 20 } },
        ]),
      ),
    ];
    await write(item, [
      { op: "patch", id: first, values: { count: 10, note: "other" } },
      { op: "patch", id: third, values: { count: 30 } },
    ]);
    value(await device.catchUp());
    expect(await deviceRows(device, item)).toEqual({
      [first]: { count: 10, note: "offline" },
      [second]: { count: 20 },
      [third]: { count: 30 },
    });

    const report = value(await device.drain());
    expect(verdictOf(report, edits[0]!.id)).toBe("conflicted");
    expect(verdictOf(report, edits[1]!.id)).toBe("accepted");
    expect(
      report.verdicts.find((entry) => entry.id === edits[0]!.id)?.conflicts,
    ).toEqual([{ row: first, column: "note" }]);
    const kept = await queued(device, edits[0]!.id);
    expect(kept.verdict).toBe("conflicted");
    expect(kept.conflicts).toEqual([{ row: first, column: "note" }]);
    expect(await serverRows(item)).toEqual({
      [first]: { count: 10, note: "offline" },
      [second]: { count: 20 },
      [third]: { count: 30 },
    });

    const batch = (JSON.parse(kept.answer!) as Written).batch!;
    const undone = await working.undoBatch(item, "steps", batch);
    expect(undone.status, JSON.stringify(undone.error)).toBe(200);
    expect((await serverRows(item))[first]).toEqual({
      count: 10,
      note: "other",
    });
  });

  it("queues an undo, sends it under its key, and takes the rows it put back from its rows.changed", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    await write(item, [{ op: "put", id: row, values: { count: 1 } }]);
    const changed = await write(item, [
      { op: "patch", id: row, values: { count: 7 } },
    ]);
    const device = await holding(type, "undo");
    const undo = value(await device.undoRows(item, "steps", changed.batch!));
    expect(undo).toMatchObject({
      kind: "undo_rows",
      item_id: item,
      table: "steps",
      body: { batch: changed.batch },
    });
    expect(await deviceRows(device, item)).toEqual({ [row]: { count: 7 } });
    expect(verdictOf(value(await device.drain()), undo.id)).toBe("accepted");
    expect(await serverRows(item)).toEqual({ [row]: { count: 1 } });
    value(await device.catchUp());
    expect(await deviceRows(device, item)).toEqual({ [row]: { count: 1 } });
  });
});

describe("how a drain sends row writes", () => {
  it("sends consecutive writes to one table in one batch under the first write's key, and records each write's own results", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const device = await holding(type, "joined");
    const [first, second] = [uuidv7(), uuidv7()];
    const writes = [
      value(
        await device.writeRows(item, "steps", [
          { op: "put", id: first, values: { count: 1 } },
        ]),
      ),
      value(
        await device.writeRows(item, "steps", [
          { op: "patch", id: first, values: { note: "b" } },
          { op: "put", id: second, values: { count: 2 } },
        ]),
      ),
      value(
        await device.writeRows(item, "steps", [{ op: "delete", id: second }]),
      ),
    ];
    const report = value(await device.drain());
    expect(writes.map((one) => verdictOf(report, one.id))).toEqual([
      "accepted",
      "accepted",
      "accepted",
    ]);
    const answered = await Promise.all(
      writes.map((one) => queued(device, one.id)),
    );
    expect(answered.map((one) => one.batched_with)).toEqual([
      null,
      writes[0]!.id,
      writes[0]!.id,
    ]);
    const answers = answered.map((one) => JSON.parse(one.answer!) as Written);
    expect(new Set(answers.map((one) => one.batch)).size).toBe(1);
    expect(answers.map((one) => one.results)).toEqual([
      [{ id: first, outcome: "created" }],
      [
        { id: first, outcome: "patched" },
        { id: second, outcome: "created" },
      ],
      [{ id: second, outcome: "deleted" }],
    ]);
    const listed = await working.rawRequest<{ data: { id: string }[] }>(
      `/items/${item}/tables/steps/batches`,
    );
    expect(listed.data.data.map((one) => one.id)).toEqual([answers[0]!.batch]);
  });

  it("sends no write in another write's batch past a write queued between them", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const device = await holding(type, "between");
    const before = value(
      await device.writeRows(item, "steps", [
        { op: "put", values: { count: 1 } },
      ]),
    );
    value(await device.addTag(item, "between"));
    const after = value(
      await device.writeRows(item, "steps", [
        { op: "put", values: { count: 2 } },
      ]),
    );
    const report = value(await device.drain());
    expect([verdictOf(report, before.id), verdictOf(report, after.id)]).toEqual(
      ["accepted", "accepted"],
    );
    const [one, two] = [
      await queued(device, before.id),
      await queued(device, after.id),
    ];
    expect(two.batched_with).toBeNull();
    expect((JSON.parse(one.answer!) as Written).batch).not.toBe(
      (JSON.parse(two.answer!) as Written).batch,
    );
  });

  it("refuses only the write whose operation the server refuses, and sends the batch's other writes again in the same drain", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const [kept, gone] = [uuidv7(), uuidv7()];
    await write(item, [
      { op: "put", id: kept, values: { count: 1 } },
      { op: "put", id: gone, values: { count: 2 } },
    ]);
    const device = await holding(type, "split");
    await write(item, [{ op: "delete", id: gone }]);
    const added = uuidv7();
    const writes = [
      value(
        await device.writeRows(item, "steps", [
          { op: "patch", id: kept, values: { note: "kept" } },
        ]),
      ),
      value(
        await device.writeRows(item, "steps", [
          { op: "put", id: added, values: { count: 3 } },
          { op: "patch", id: gone, values: { note: "lost" } },
        ]),
      ),
      value(
        await device.writeRows(item, "steps", [
          { op: "patch", id: kept, values: { count: 10 } },
        ]),
      ),
    ];
    const report = value(await device.drain());
    expect(writes.map((one) => verdictOf(report, one.id))).toEqual([
      "accepted",
      "refused",
      "accepted",
    ]);
    const refusedWrite = await queued(device, writes[1]!.id);
    expect(JSON.parse(refusedWrite.answer!)).toMatchObject({
      error: { code: "row_not_found", details: { operation: 1 } },
    });
    expect(await serverRows(item)).toEqual({
      [kept]: { count: 10, note: "kept" },
    });
    const [first, last] = [
      await queued(device, writes[0]!.id),
      await queued(device, writes[2]!.id),
    ];
    expect((JSON.parse(first.answer!) as Written).batch).toBe(
      (JSON.parse(last.answer!) as Written).batch,
    );
    expect(first.idempotency_key).not.toBe(writes[0]!.idempotency_key);
  });

  it("refuses every write of a batch the server refuses naming no operation", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const device = await holding(type, "whole-refusal");
    const writes = [
      value(
        await device.writeRows(item, "steps", [
          { op: "put", values: { count: 1 } },
        ]),
      ),
      value(
        await device.writeRows(item, "steps", [
          { op: "put", values: { count: 2 } },
        ]),
      ),
    ];
    const trashed = await working.deleteItem(item);
    expect(trashed.ok, JSON.stringify(trashed.error)).toBe(true);
    const report = value(await device.drain());
    expect(writes.map((one) => verdictOf(report, one.id))).toEqual([
      "refused",
      "refused",
    ]);
    for (const one of writes) {
      expect((await queued(device, one.id)).refusal).toMatchObject({
        code: "item_not_found",
      });
    }
  });
});
