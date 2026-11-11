import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import {
  CliDevice,
  newStore,
  type HeldCommand,
} from "../../device/cli-adapter.js";
import type {
  Change,
  DrainReport,
  Outcome,
  QueuedWrite,
  RowConflict,
} from "../../device/protocol.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { QUIET_SCHEDULE, quiet } from "../../utils/moved-clock.js";
import { collectUntil, withStream } from "../../utils/stream.js";
import { requireBinary } from "./harness.js";

/**
 * One table kept on two devices, written on both and drained from both, one of
 * them offline for a while, against one server: what each write is told, and
 * that both copies end as the server holds the table.
 *
 * The table is an item of `core.table` that device A made, so its columns are
 * the item's own and change with the item. A holds its table and B holds it
 * too. A device's store has one writer, so a `follow` that holds the stream
 * is the observer of a window in which the other device acts, and a command
 * that writes runs while no follow holds the store.
 */

interface Row {
  id: string;
  values: Record<string, unknown>;
  updated_at: string;
}

interface Page {
  data: Row[];
  held: boolean;
}

interface Batch {
  batch: string | null;
  results: { id: string; outcome: string }[];
}

const COLUMNS = {
  name: { type: "string", required: true },
  amount: { type: "number", adds_up: "sum" },
  qty: { type: "integer", minimum: 0 },
  kind: { type: "enum", enum_values: ["food", "rent", "fun"] },
  paid: { type: "boolean" },
  due: { type: "date" },
};

const { qty: _removed, ...KEPT_COLUMNS } = COLUMNS;
const CHANGED_COLUMNS = { ...KEPT_COLUMNS, note: { type: "string" } };

const [r1, r2, r3, r4, r5, r6, r7, r8, r9] = Array.from({ length: 9 }, () =>
  uuidv7(),
);

const POLL_MS = 10;
const WAIT_MS = 30_000;

let server: FreshServer;
let everything: MarfaClient;
let everythingKey: string;
let a: CliDevice;
let b: CliDevice;
let item: string;
let gateDir: string;
let unreachable: string;
const timings: Record<string, number> = {};
const loads: Record<string, number> = {};
const held: HeldCommand[] = [];

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

function mark(name: string, ms: number): void {
  timings[name] = Math.round(ms);
  loads[name] = loadavg()[0]!;
}

async function closedPort(): Promise<string> {
  const listener = createServer();
  await new Promise<void>((ready) => listener.listen(0, "127.0.0.1", ready));
  const address = listener.address();
  if (address === null || typeof address === "string") {
    throw new Error("the listener has no port");
  }
  await new Promise((done) => listener.close(done));
  return `http://127.0.0.1:${String(address.port)}`;
}

beforeAll(async () => {
  server = await bootFreshServer("cli-two-devices", QUIET_SCHEDULE);
  await quiet(server, ["event-log-cleanup"]);
  const local = new MarfaClient({
    baseUrl: server.apiUrl,
    controlSocket: server.controlSocket,
  });
  const minted = await local.createKey({
    label: "two devices",
    source: `two-devices-${randomUUID()}`,
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  everythingKey = minted.data.key;
  everything = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: everythingKey,
  });
  a = new CliDevice({
    binary: requireBinary(),
    store: newStore("two-devices-a"),
    url: server.apiUrl,
    key: everythingKey,
  });
  b = new CliDevice({
    binary: requireBinary(),
    store: newStore("two-devices-b"),
    url: server.apiUrl,
    key: server.workingKey,
  });
  gateDir = mkdtempSync(join(tmpdir(), "marfa-two-devices-gate-"));
  unreachable = await closedPort();
}, FRESH_SERVER_TIMEOUT_MS);

afterEach(async () => {
  for (const command of held) if (command.running()) await command.stop();
});

afterAll(async () => {
  for (const command of held) await command.stop();
  rmSync(gateDir, { recursive: true, force: true });
  await server.stop();
  const report = process.env.MARFA_TWO_DEVICES_REPORT;
  const text = JSON.stringify({ timings_ms: timings, load_1m: loads }, null, 2);
  console.log(`two devices: ${text}`);
  if (report !== undefined && report !== "") writeFileSync(report, text);
}, FRESH_SERVER_TIMEOUT_MS);

async function serverRows(): Promise<Row[]> {
  const answer = await everything.rawRequest<{ data: Row[] }>(
    `/items/${item}/tables/table/rows?limit=1000`,
  );
  expect(answer.status, JSON.stringify(answer.error)).toBe(200);
  return answer.data.data;
}

async function copyRows(device: CliDevice): Promise<Row[]> {
  const page = value(
    await device.tableRead<Page>(["list", item, "table", "--limit", "1000"]),
  );
  expect(page.held, "the copy answered, not the server").toBe(true);
  return page.data;
}

async function serverBatches(): Promise<
  { id: string; rows: number; undoes: string | null }[]
> {
  const answer = await everything.listBatches(item, "table", { limit: 100 });
  expect(answer.status, JSON.stringify(answer.error)).toBe(200);
  return answer.data.data;
}

/** Waits until a device's copy holds the table as the server does. */
async function converged(device: CliDevice, what: string): Promise<void> {
  const reader = device.reopen({ reader: true });
  const started = performance.now();
  for (;;) {
    const [expected, actual] = [await serverRows(), await copyRows(reader)];
    if (JSON.stringify(expected) === JSON.stringify(actual)) {
      return;
    }
    if (performance.now() - started > WAIT_MS) {
      expect(actual, `${what}: the copy never matched the server`).toEqual(
        expected,
      );
    }
    await sleep(POLL_MS);
  }
}

function valuesById(rows: Row[]): Record<string, Record<string, unknown>> {
  return Object.fromEntries(rows.map((row) => [row.id, row.values]));
}

function rowsChanged(command: HeldCommand): Change[] {
  return command.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Change)
    .filter(
      (change) => change.event === "rows.changed" && change.item_id === item,
    );
}

/** The follow's lines for the table, until it has told `count`; when the last arrived. */
async function toldRowsChanged(
  command: HeldCommand,
  count: number,
): Promise<number> {
  const started = performance.now();
  while (rowsChanged(command).length < count) {
    if (!command.running()) {
      throw new Error(`the follow ended: ${command.stderr}`);
    }
    if (performance.now() - started > WAIT_MS) {
      throw new Error(
        `the follow told ${String(rowsChanged(command).length)} of ${String(count)} rows.changed: ${command.stdout}`,
      );
    }
    await sleep(POLL_MS);
  }
  return performance.now();
}

function follow(device: CliDevice): HeldCommand {
  const command = device.holdFollow();
  held.push(command);
  return command;
}

async function endFollow(command: HeldCommand): Promise<void> {
  command.interrupt();
  await Promise.race([command.exited(), sleep(10_000)]);
  if (command.running()) await command.stop();
  expect(command.exitCode(), command.stderr).toBe(0);
}

function verdictOf(report: DrainReport, write: QueuedWrite) {
  const entry = report.verdicts.find((verdict) => verdict.id === write.id);
  expect(entry, `the drain told nothing of ${write.id}`).toBeDefined();
  return entry!;
}

async function queued(device: CliDevice, write: QueuedWrite) {
  const found = value(await device.queue()).find(
    (entry) => entry.id === write.id,
  );
  expect(found, `the queue lost ${write.id}`).toBeDefined();
  return found!;
}

function conflictsOf(conflicts: RowConflict[]): string[] {
  return conflicts
    .map((conflict) => `${conflict.row}.${conflict.column}`)
    .sort();
}

describe("one table on two devices", () => {
  it("makes a table of several kinds on device A, which holds it, and device B holds it too", async () => {
    value(await a.hydrate(["core.table"], "library"));
    const made = value(
      await a.create({
        type: "core.table",
        properties: { title: "Household budget", columns: COLUMNS },
      }),
    );
    item = made.item_id!;
    const sent = value(await a.drain());
    expect(verdictOf(sent, made).verdict).toBe("accepted");
    expect(value(await a.holdTable("core.table", "table")).fill).toMatchObject({
      whole: 1,
      rows: 0,
    });

    value(await b.hydrate(["core.table"], "library"));
    expect(value(await b.holdTable("core.table", "table")).fill).toMatchObject({
      whole: 1,
      rows: 0,
    });

    const stored = await everything.getItem(item);
    expect(stored.data.item.properties.columns).toEqual(COLUMNS);
    const copy = value(await b.get(item));
    expect(copy.properties.columns).toEqual(COLUMNS);
  });

  it("shows each device the rows the other wrote while both are online, through rows.changed", async () => {
    const watching = follow(b);
    await sleep(1_000);
    const first = value(
      await a.writeRows(item, "table", [
        {
          op: "put",
          id: r1,
          values: {
            name: "rent",
            amount: 900,
            qty: 1,
            kind: "rent",
            paid: false,
            due: "2026-12-01",
          },
        },
        {
          op: "put",
          id: r2,
          values: { name: "groceries", amount: 120.5, qty: 3, kind: "food" },
        },
        { op: "put", id: r3, values: { name: "cinema", amount: 30 } },
      ]),
    );
    const sentAt = performance.now();
    expect(verdictOf(value(await a.drain()), first).verdict).toBe("accepted");
    mark(
      "a_rows_reach_b_follow_ms",
      (await toldRowsChanged(watching, 1)) - sentAt,
    );
    await endFollow(watching);
    value(await a.catchUp());
    expect(valuesById(await copyRows(b))).toEqual({
      [r1]: {
        name: "rent",
        amount: 900,
        qty: 1,
        kind: "rent",
        paid: false,
        due: "2026-12-01",
      },
      [r2]: { name: "groceries", amount: 120.5, qty: 3, kind: "food" },
      [r3]: { name: "cinema", amount: 30 },
    });

    const watchingA = follow(a);
    await sleep(1_000);
    const second = [
      value(
        await b.writeRows(item, "table", [
          { op: "put", id: r4, values: { name: "gym", amount: 40, qty: 1 } },
          { op: "put", id: r5, values: { name: "taxi", amount: 18 } },
        ]),
      ),
      value(
        await b.writeRows(item, "table", [
          { op: "patch", id: r1, values: { paid: true } },
        ]),
      ),
    ];
    const sentSecond = performance.now();
    const drained = value(await b.drain());
    for (const write of second) {
      expect(verdictOf(drained, write).verdict).toBe("accepted");
    }
    mark(
      "b_rows_reach_a_follow_ms",
      (await toldRowsChanged(watchingA, 1)) - sentSecond,
    );
    await endFollow(watchingA);
    value(await b.catchUp());

    const expected = await serverRows();
    expect(valuesById(expected)).toMatchObject({
      [r1]: { name: "rent", paid: true },
      [r4]: { name: "gym", amount: 40, qty: 1 },
      [r5]: { name: "taxi", amount: 18 },
    });
    expect(await copyRows(a)).toEqual(expected);
    expect(await copyRows(b)).toEqual(expected);
    const totals = await everything.rowTotals(item, "table");
    for (const device of [a, b]) {
      expect(
        value(await device.tableRead<unknown>(["totals", item, "table"])),
      ).toMatchObject(totals.data as object);
    }
    expect(await serverBatches()).toHaveLength(2);
  });

  let offline: CliDevice;
  let edits: Record<"clash" | "apart" | "own" | "gone" | "unfit", QueuedWrite>;

  it("keeps device B's edits while it cannot reach the server, shown on its copy and sent to nobody", async () => {
    offline = b.reopen({ url: unreachable });
    edits = {
      clash: value(
        await offline.writeRows(item, "table", [
          { op: "patch", id: r2, values: { amount: 125 } },
        ]),
      ),
      apart: value(
        await offline.writeRows(item, "table", [
          { op: "patch", id: r3, values: { kind: "food" } },
        ]),
      ),
      own: value(
        await offline.writeRows(item, "table", [
          { op: "put", id: r6, values: { name: "phone", amount: 35 } },
          { op: "put", id: r7, values: { name: "museum", amount: 22 } },
        ]),
      ),
      gone: value(
        await offline.writeRows(item, "table", [{ op: "delete", id: r5 }]),
      ),
      unfit: value(
        await offline.writeRows(item, "table", [
          { op: "patch", id: r4, values: { qty: 2 } },
        ]),
      ),
    };

    const shown = valuesById(await copyRows(offline));
    expect(shown[r2]).toMatchObject({ amount: 125 });
    expect(shown[r3]).toEqual({ name: "cinema", amount: 30, kind: "food" });
    expect(shown[r6]).toEqual({ name: "phone", amount: 35 });
    expect(shown[r7]).toEqual({ name: "museum", amount: 22 });
    expect(shown[r4]).toMatchObject({ qty: 2 });
    expect(shown).not.toHaveProperty(r5);

    const report = value(await offline.drain());
    expect(report.unavailable).toContain("nothing was sent");
    expect([report.answered, report.undelivered, report.verdicts]).toEqual([
      0,
      Object.keys(edits).length,
      [],
    ]);
    for (const write of Object.values(edits)) {
      expect((await queued(offline, write)).answered_at).toBeNull();
    }
    expect(await serverBatches()).toHaveLength(2);
  });

  it("takes device A's edits to the same rows and its change to the table's columns meanwhile", async () => {
    const [edited, other, behind, added] = [
      value(
        await a.writeRows(item, "table", [
          { op: "patch", id: r2, values: { amount: 140 } },
        ]),
      ),
      value(
        await a.writeRows(item, "table", [
          { op: "patch", id: r3, values: { paid: true } },
        ]),
      ),
      value(
        await a.writeRows(item, "table", [
          { op: "patch", id: r5, values: { amount: 55 } },
        ]),
      ),
      value(
        await a.writeRows(item, "table", [
          { op: "put", id: r8, values: { name: "flowers", amount: 12 } },
        ]),
      ),
    ];
    const version = value(await a.get(item)).version;
    const changed = value(
      await a.update(item, {
        properties: { columns: CHANGED_COLUMNS },
        version,
      }),
    );
    const drained = value(await a.drain());
    for (const write of [edited, other, behind, added, changed]) {
      expect(verdictOf(drained, write).verdict).toBe("accepted");
    }
    value(await a.catchUp());
    const stored = await everything.getItem(item);
    expect(stored.data.item.properties.columns).toEqual(CHANGED_COLUMNS);
    expect(valuesById(await serverRows())[r2]).toMatchObject({ amount: 140 });
  });

  let resent: string;

  it("sends device B's edits once it can reach the server, telling each write what became of it", async () => {
    const watching = follow(a);
    await sleep(1_000);
    const before = rowsChanged(watching).length;

    const backAt = performance.now();
    value(await b.catchUp());
    const caughtUp = performance.now();
    mark("b_catch_up_ms", caughtUp - backAt);
    expect(
      (value(await b.get(item)).properties as { columns: unknown }).columns,
    ).toEqual(CHANGED_COLUMNS);

    const drainStarted = performance.now();
    const report = value(await b.drain());
    const drainEnded = performance.now();
    mark("b_drain_ms", drainEnded - drainStarted);

    expect(verdictOf(report, edits.clash).verdict).toBe("conflicted");
    expect(conflictsOf(verdictOf(report, edits.clash).conflicts)).toEqual([
      `${r2}.amount`,
    ]);
    expect(verdictOf(report, edits.apart).verdict).toBe("accepted");
    expect(verdictOf(report, edits.own).verdict).toBe("accepted");
    expect(verdictOf(report, edits.gone).verdict).toBe("conflicted");
    expect(conflictsOf(verdictOf(report, edits.gone).conflicts)).toEqual([
      `${r5}.amount`,
    ]);
    const refused = verdictOf(report, edits.unfit);
    expect(refused.verdict).toBe("refused");
    expect(refused.refusal?.code).toBe("validation_error");
    const kept = await queued(b, edits.unfit);
    expect(JSON.parse(kept.answer!)).toMatchObject({
      error: { code: "validation_error", details: { operation: 0 } },
    });
    expect(kept.body).toEqual({
      operations: [{ op: "patch", id: r4, values: { qty: 2 } }],
    });
    expect(JSON.stringify(refused.refusal)).toContain("qty");

    const sentBatch = await queued(b, edits.clash);
    resent = (JSON.parse(sentBatch.answer!) as Batch).batch!;
    for (const write of [edits.apart, edits.own, edits.gone]) {
      expect(
        (JSON.parse((await queued(b, write)).answer!) as Batch).batch,
      ).toBe(resent);
    }

    const reached = (await toldRowsChanged(watching, before + 1)) - backAt;
    mark("b_back_to_a_follow_ms", reached);
    await converged(a, "after device B came back");
    mark("b_back_to_a_copy_ms", performance.now() - backAt);
    await endFollow(watching);
    value(await b.catchUp());

    expect(valuesById(await serverRows())).toEqual({
      [r1]: {
        name: "rent",
        amount: 900,
        qty: 1,
        kind: "rent",
        paid: true,
        due: "2026-12-01",
      },
      [r2]: { name: "groceries", amount: 125, qty: 3, kind: "food" },
      [r3]: { name: "cinema", amount: 30, paid: true, kind: "food" },
      [r4]: { name: "gym", amount: 40, qty: 1 },
      [r6]: { name: "phone", amount: 35 },
      [r7]: { name: "museum", amount: 22 },
      [r8]: { name: "flowers", amount: 12 },
    });
    const expected = await serverRows();
    expect(await copyRows(a)).toEqual(expected);
    expect(await copyRows(b)).toEqual(expected);
    const ledger = await serverBatches();
    expect(ledger.map((batch) => batch.rows).reverse()).toEqual([3, 3, 4, 5]);
  });

  it("puts back what device B's batch changed when device A undoes it, on the server and on both copies", async () => {
    const undo = value(await a.undoRows(item, "table", resent));
    const watching = follow(b);
    await sleep(1_000);
    const before = rowsChanged(watching).length;
    const undoneAt = performance.now();
    expect(verdictOf(value(await a.drain()), undo).verdict).toBe("accepted");
    mark(
      "a_undo_reaches_b_follow_ms",
      (await toldRowsChanged(watching, before + 1)) - undoneAt,
    );
    await endFollow(watching);
    value(await a.catchUp());

    expect(valuesById(await serverRows())).toEqual({
      [r1]: {
        name: "rent",
        amount: 900,
        qty: 1,
        kind: "rent",
        paid: true,
        due: "2026-12-01",
      },
      [r2]: { name: "groceries", amount: 140, qty: 3, kind: "food" },
      [r3]: { name: "cinema", amount: 30, paid: true },
      [r4]: { name: "gym", amount: 40, qty: 1 },
      [r5]: { name: "taxi", amount: 55 },
      [r8]: { name: "flowers", amount: 12 },
    });
    const expected = await serverRows();
    expect(await copyRows(a)).toEqual(expected);
    expect(await copyRows(b)).toEqual(expected);
    const [latest] = await serverBatches();
    expect(latest?.undoes).toBe(resent);
  });

  it("answers a batch device B's process was killed in the middle of sending once, never writing it twice", async () => {
    const batchesBefore = (await serverBatches()).length;
    value(await b.catchUp());
    const cursor = value(await b.status()).event_cursor!;
    const writes = [
      value(
        await b.writeRows(item, "table", [
          { op: "put", id: r9, values: { name: "tickets", amount: 60 } },
          { op: "put", values: { name: "minted", amount: 1 } },
        ]),
      ),
      value(
        await b.writeRows(item, "table", [
          { op: "patch", id: r1, values: { amount: 950 } },
        ]),
      ),
    ];

    const gate = join(gateDir, "gate-drain-receipt");
    const draining = b.hold(["drain"], "device", {
      MARFA_TEST_FAULT: `gate-drain-receipt=${gate}`,
    });
    held.push(draining);
    const reached = performance.now();
    while (readReach(gate) < 1) {
      if (!draining.running()) {
        throw new Error(`the drain ended before its gate: ${draining.stderr}`);
      }
      if (performance.now() - reached > WAIT_MS) {
        throw new Error(
          "the drain never reached its gate; the device must be a debug build",
        );
      }
      await sleep(POLL_MS);
    }
    await draining.stop();

    expect(await serverBatches()).toHaveLength(batchesBefore + 1);
    for (const write of writes) {
      const kept = await queued(b, write);
      expect([kept.verdict, kept.answered_at]).toEqual([null, null]);
    }

    const resumedAt = performance.now();
    const report = value(await b.drain());
    mark("b_restart_drain_ms", performance.now() - resumedAt);
    for (const write of writes) {
      const told = verdictOf(report, write);
      expect([told.verdict, told.replayed]).toEqual(["accepted", true]);
    }
    expect(await serverBatches()).toHaveLength(batchesBefore + 1);

    const rows = await serverRows();
    expect(rows.filter((row) => row.values.name === "minted")).toHaveLength(1);
    expect(valuesById(rows)[r1]).toMatchObject({ amount: 950 });

    const marker = await everything.createItem({
      type: "core.note",
      properties: { title: "end of the log" },
    } as never);
    expect(marker.status, JSON.stringify(marker.error)).toBe(201);
    const logged = await withStream(
      server.apiUrl,
      everythingKey,
      { lastEventId: cursor },
      async (stream) =>
        collectUntil(
          stream,
          (events) =>
            events.some(
              (event) =>
                (event.data as { item?: { id?: string } }).item?.id ===
                marker.data.item.id,
            ),
          "the end of the log",
        ),
    );
    const announced = logged.events.filter(
      (event) =>
        event.event === "rows.changed" &&
        (event.data as { item: { id: string } }).item.id === item,
    );
    const [latest] = await serverBatches();
    expect(
      announced.map((event) => (event.data as { batch: string }).batch),
    ).toEqual([latest!.id]);

    value(await a.catchUp());
    value(await b.catchUp());
    const expected = await serverRows();
    expect(await copyRows(a)).toEqual(expected);
    expect(await copyRows(b)).toEqual(expected);
    expect(
      value(await b.queue()).filter((write) => write.answered_at === null),
    ).toEqual([]);
  });

  it("writes twice a batch sent under two keys, which is what the key prevents", async () => {
    const operations = [{ op: "put", values: { name: "witness", amount: 1 } }];
    for (const key of [randomUUID(), randomUUID()]) {
      const answer = await everything.rawRequest(
        `/items/${item}/tables/table/rows`,
        {
          method: "POST",
          headers: { "Idempotency-Key": key },
          body: { operations },
        },
      );
      expect(answer.status, JSON.stringify(answer.error)).toBe(200);
    }
    expect(
      (await serverRows()).filter((row) => row.values.name === "witness"),
    ).toHaveLength(2);
  });
});

function readReach(path: string): number {
  try {
    return Number(readFileSync(`${path}.ready`, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}
