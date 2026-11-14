import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
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
const proxies: RowsProxy[] = [];

beforeAll(async () => {
  server = await bootFreshServer("device-table-writes", QUIET_SCHEDULE);
  ({ working } = clientsFor(server));
  minter = await everythingClient(server);
  await quiet(server, ["event-log-cleanup"]);
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  for (const binding of bindings) await binding.close();
  for (const proxy of proxies) await proxy.stop();
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

function deviceFor(
  label: string,
  key = server.workingKey,
  url = server.apiUrl,
): CliDevice {
  counter += 1;
  return new CliDevice({
    binary: requireBinary(),
    store: newStore(`table-writes-${label}-${String(counter)}`),
    url,
    key,
  });
}

/** A device holding the `steps` table of every item of `type`, whole. */
async function holding(
  type: string,
  label: string,
  key = server.workingKey,
  url = server.apiUrl,
): Promise<CliDevice> {
  const device = deviceFor(label, key, url);
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

/** What the proxy answers a row write or an undo in place of the server. */
type Reply =
  | { forward: boolean; status: number; body: string }
  | { forward: true; lose: true }
  | { forward: false; gateway: number };

/** Between a device and the server, answering row writes and undos as told. */
class RowsProxy {
  /** Taken one per row write or undo, in order; the server answers the rest. */
  readonly replies: Reply[] = [];
  /** Answers every row write to `item` while set. */
  refusing: { item: string; gateway: number } | null = null;
  /** What the proxy answers the event stream while set: a refusal, a stream that ends at once, or one that stays open and says nothing. */
  events: "refuse" | "end" | "silent" | null = null;
  /** Each request for the event stream that reached the proxy. */
  eventRequests = 0;
  /** The request for the event stream, counted as `eventRequests` counts, that the proxy holds 8 seconds before it passes it on. */
  slowEventRequest = 0;
  /** Holds each read of a table's rows 8 seconds before it passes it on, while set. */
  slowRowReads = false;
  /** The method and path of each request that reached the proxy, in order. */
  readonly asked: string[] = [];
  /** Each row write that reached the proxy, in order. */
  readonly sent: { key: string | undefined; body: unknown }[] = [];
  private contract = "";

  private constructor(
    private readonly listener: Server,
    readonly url: string,
  ) {}

  static async start(): Promise<RowsProxy> {
    const listener = createServer();
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    const { port } = listener.address() as AddressInfo;
    const proxy = new RowsProxy(listener, `http://127.0.0.1:${String(port)}`);
    listener.on("request", (request, response) => {
      proxy.pass(request, response).catch(() => response.destroy());
    });
    return proxy;
  }

  private async pass(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [name, sent] of Object.entries(request.headers)) {
      if (
        sent !== undefined &&
        !["host", "connection", "content-length"].includes(name)
      )
        headers.set(name, Array.isArray(sent) ? sent.join(", ") : sent);
    }
    const path = request.url ?? "/";
    this.asked.push(`${request.method ?? ""} ${path}`);
    if (
      this.slowRowReads &&
      request.method === "GET" &&
      /^\/items\/[^/]+\/tables\/[^/]+\/rows/.test(path)
    )
      await new Promise((resolve) => setTimeout(resolve, 8_000));
    if (path.startsWith("/events")) {
      this.eventRequests += 1;
      if (this.eventRequests === this.slowEventRequest)
        await new Promise((resolve) => setTimeout(resolve, 8_000));
      if (this.events === "refuse") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { code: "unavailable", message: "down" } }),
        );
        return;
      }
      if (this.events === "end") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "x-marfa-contract": this.contract,
        });
        response.end(": connected\n\n");
        return;
      }
      if (this.events === "silent") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "x-marfa-contract": this.contract,
        });
        response.write(": connected\n\n");
        return;
      }
    }
    const rows =
      request.method === "POST" &&
      /^\/items\/[^/]+\/tables\/[^/]+\/(rows|batches\/[^/]+\/undo)$/.test(path);
    if (rows && path.endsWith("/rows"))
      this.sent.push({
        key: headers.get("idempotency-key") ?? undefined,
        body: JSON.parse(body.toString("utf8")) as unknown,
      });
    const reply = !rows
      ? undefined
      : this.refusing !== null &&
          path.startsWith(`/items/${this.refusing.item}/`)
        ? ({ forward: false, gateway: this.refusing.gateway } as const)
        : this.replies.shift();
    if (reply !== undefined && "gateway" in reply) {
      response.writeHead(reply.gateway, { "content-type": "text/html" });
      response.end("<html>refused by a gateway</html>");
      return;
    }
    if (reply !== undefined && !reply.forward && "status" in reply) {
      response.writeHead(reply.status, {
        "content-type": "application/json",
        "x-marfa-contract": this.contract,
      });
      response.end(reply.body);
      return;
    }
    const upstream = await fetch(`${server.apiUrl}${path}`, {
      method: request.method,
      headers,
      ...(body.length === 0 ? {} : { body }),
      redirect: "manual",
    });
    this.contract = upstream.headers.get("x-marfa-contract") ?? this.contract;
    const returned: Record<string, string> = {};
    upstream.headers.forEach((kept, name) => {
      if (
        !["content-length", "content-encoding", "transfer-encoding"].includes(
          name,
        )
      )
        returned[name] = kept;
    });
    if (reply !== undefined) {
      await upstream.text();
      if ("lose" in reply) {
        request.socket.destroy();
        return;
      }
      response.writeHead(reply.status, returned);
      response.end(reply.body);
      return;
    }
    response.writeHead(upstream.status, returned);
    if (upstream.body === null) {
      response.end();
      return;
    }
    const stream = Readable.fromWeb(upstream.body as never);
    stream.on("error", () => response.destroy());
    response.on("close", () => stream.destroy());
    stream.pipe(response);
  }

  async stop(): Promise<void> {
    this.listener.closeAllConnections();
    await new Promise<void>((resolve) => this.listener.close(() => resolve()));
  }
}

async function proxied(): Promise<RowsProxy> {
  const proxy = await RowsProxy.start();
  proxies.push(proxy);
  return proxy;
}

/** A drain with `fault` set for the binary it starts. */
async function drainWith(
  device: CliDevice,
  fault: string,
): Promise<Outcome<DrainReport>> {
  process.env.MARFA_TEST_FAULT = fault;
  try {
    return await device.drain();
  } finally {
    delete process.env.MARFA_TEST_FAULT;
  }
}

function told(report: DrainReport, id: string): DrainReport["verdicts"] {
  return report.verdicts.filter((entry) => entry.id === id);
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

/** A type whose `steps` table has a required column, an item holding one row, and a device holding the table whole. */
async function sized(label: string): Promise<{
  type: string;
  item: string;
  row: string;
  device: CliDevice;
}> {
  counter += 1;
  const type = `user.table-sized-${String(counter)}`;
  const made = await working.registerType({
    id: type,
    fields: { title: { type: "string" } },
    tables: {
      steps: {
        columns: {
          title: { type: "string", required: true },
          note: { type: "string" },
          other: { type: "string" },
        },
      },
    },
  } as never);
  expect(made.status, JSON.stringify(made.error)).toBe(201);
  const item = await itemOf(type);
  const row = uuidv7();
  await write(item, [
    { op: "put", id: row, values: { title: "t", note: "x".repeat(60_000) } },
  ]);
  const device = await holding(type, label);
  return { type, item, row, device };
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

  /** A device holding one row whose `ref` its key may not read. */
  async function judging(label: string): Promise<{
    device: CliDevice;
    item: string;
    row: string;
  }> {
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
    const device = await holding(type, label, narrow.key);
    const held = await devicePage(device, item);
    expect(held.data[0]?.withheld).toEqual(["ref"]);
    return { device, item, row };
  }

  async function unchanged(device: CliDevice, item: string): Promise<void> {
    expect(value(await device.queue())).toEqual([]);
    expect(Object.values(await deviceRows(device, item))).toEqual([
      { count: 1 },
    ]);
  }

  it("refuses a write to an item the copy does not hold or a table its item does not have", async () => {
    const { device, item } = await judging("unnamed");
    const other = await tableType();
    const unheld = await itemOf(other);
    const notHeld = refused(
      await device.writeRows(unheld, "steps", [
        { op: "put", values: { count: 1 } },
      ]),
    );
    expect(notHeld.code).toBe("not_found");
    expect(notHeld.raw).toContain("item_not_found");

    for (const table of ["nothing", "table"]) {
      const undeclared = refused(
        await device.writeRows(item, table, [
          { op: "put", values: { count: 1 } },
        ]),
      );
      expect(undeclared.code).toBe("not_found");
      expect(undeclared.raw).toContain("table_not_found");
    }
    await unchanged(device, item);
  });

  it("refuses a write whose operations the server would refuse, naming the operation", async () => {
    const { device, item, row } = await judging("judged");
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
        "validation",
      );
      expect(judged.raw).toContain("validation_error");
      expect(judged.raw).toContain(named);
    }
    await unchanged(device, item);
  });

  it("refuses a row over the size limit and a put without a required column, as the server does, queueing nothing", async () => {
    const { item, row, device } = await sized("sized");
    const big = (length: number): string => "x".repeat(length);
    const sentToServer = await working.writeRows(item, "steps", {
      operations: [
        { op: "put", id: row, values: { title: "t", note: big(70_000) } },
      ],
    });
    expect(sentToServer.status).toBe(400);
    for (const [operations, named] of [
      [
        [{ op: "put", id: row, values: { note: "x" } }],
        "operations.0.values.title",
      ],
      [[{ op: "put", values: { note: "x" } }], "operations.0.values.title"],
      [
        [{ op: "put", id: row, values: { title: null } }],
        "operations.0.values.title",
      ],
      [
        [{ op: "patch", id: row, values: { title: null } }],
        "operations.0.values.title",
      ],
      [
        [{ op: "put", values: { title: "t", note: big(70_000) } }],
        "operations.0.values",
      ],
      [
        [{ op: "patch", id: row, values: { other: big(10_000) } }],
        "operations.0.values",
      ],
    ] as [Operation[], string][]) {
      const judged = refused(await device.writeRows(item, "steps", operations));
      expect(judged.code, JSON.stringify(operations).slice(0, 80)).toBe(
        "validation",
      );
      expect(judged.raw).toContain(named);
    }
    const server = sentToServer.error?.error.message ?? "";
    expect(server).toContain("operations.0.values");
    const over = refused(
      await device.writeRows(item, "steps", [
        { op: "put", id: row, values: { title: "t", note: big(70_000) } },
      ]),
    );
    expect(over.raw).toContain(server);
    const grown = refused(
      await device.writeRows(item, "steps", [
        { op: "put", id: uuidv7(), values: { title: "t", note: big(40_000) } },
        {
          op: "put",
          id: row,
          values: { title: "t", note: big(40_000), other: big(30_000) },
        },
      ]),
    );
    expect(grown.raw).toContain("operations.1.values");
    expect(value(await device.queue())).toEqual([]);
    // The witness: the limit, not the shape, is what refused them.
    value(
      await device.writeRows(item, "steps", [
        {
          op: "put",
          id: row,
          values: { title: "t", note: big(40_000), other: big(20_000) },
        },
      ]),
    );
  });

  it("queues a patch of a row the copy does not hold for the server to judge its size", async () => {
    const { type, item, row } = await sized("sized-unheld");
    const loose = deviceFor("sized-unheld-copy");
    value(await loose.hydrate([type], "library"));
    const queuedPatch = value(
      await loose.writeRows(item, "steps", [
        { op: "patch", id: row, values: { note: "x".repeat(70_000) } },
      ]),
    );
    expect(queuedPatch.kind).toBe("write_rows");
    expect(verdictOf(value(await loose.drain()), queuedPatch.id)).toBe(
      "refused",
    );
  });

  it("queues each put of a batch that leaves out a required item column of a row the copy does not hold, for the server to keep what the key may not read", async () => {
    counter += 1;
    const type = `user.table-required-ref-${String(counter)}`;
    const made = await working.registerType({
      id: type,
      fields: { title: { type: "string" } },
      tables: {
        steps: {
          columns: {
            count: { type: "integer", required: true },
            ref: { type: "item", required: true },
          },
        },
      },
    } as never);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
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
    const loose = deviceFor("required-ref", narrow.key);
    value(await loose.hydrate([type], "library"));
    const queuedPut = value(
      await loose.writeRows(item, "steps", [
        { op: "put", id: row, values: { count: 2 } },
        { op: "put", id: row, values: { count: 3 } },
      ]),
    );
    expect(queuedPut.kind).toBe("write_rows");
    expect(verdictOf(value(await loose.drain()), queuedPut.id)).toBe(
      "accepted",
    );
    expect(await serverRows(item)).toEqual({
      [row]: { count: 3, ref: note.data.item.id },
    });
    // The witness: a delete leaves no row to keep a reference, so a put after it is refused.
    const fresh = uuidv7();
    const missing = refused(
      await loose.writeRows(item, "steps", [
        { op: "put", id: fresh, values: { count: 2 } },
        { op: "delete", id: fresh },
        { op: "put", id: fresh, values: { count: 3 } },
      ]),
    );
    expect(missing.raw).toContain("operations.2.values.ref");
  });

  it("refuses a write naming a column the row it holds withholds", async () => {
    const { device, item, row } = await judging("withheld");
    const withheld = refused(
      await device.writeRows(item, "steps", [
        { op: "patch", id: row, values: { ref: null } },
      ]),
    );
    expect(withheld.code).toBe("forbidden");
    expect(withheld.raw).toContain("ref");
    expect(withheld.raw).toContain("operation 0");
    await unchanged(device, item);
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
    expect(await deviceRows(device, item)).toEqual({});
    const kept = await queued(device, mine.id);
    expect(kept.refusal).toMatchObject({ code: "row_not_found" });
    expect(JSON.parse(kept.answer!)).toMatchObject({
      error: { code: "row_not_found", details: { operation: 0 } },
    });
    expect(kept.body).toEqual({
      operations: [{ op: "patch", id: row, values: { note: "mine" } }],
    });
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
    expect(
      [
        kept.conflicted_copy_id,
        report.verdicts.find((entry) => entry.id === edits[0]!.id)
          ?.conflicted_copy_id,
      ],
      "a row write conflict was given a sibling item",
    ).toEqual([null, null]);
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

describe("a drain catches up before it sends row writes", () => {
  /** A row, a device holding its table whole, and a write of the device that another writer's change then overlaps. */
  async function overlapped(label: string, url = server.apiUrl) {
    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    await write(item, [
      { op: "put", id: row, values: { count: 1, note: "a" } },
    ]);
    const device = await holding(type, label, server.workingKey, url);
    const mine = value(
      await device.writeRows(item, "steps", [
        { op: "patch", id: row, values: { note: "offline" } },
      ]),
    );
    await write(item, [{ op: "patch", id: row, values: { note: "other" } }]);
    return { type, item, row, device, mine };
  }

  it("reports a write conflicted where a drain with no catch-up before it replaced another writer's value", async () => {
    const { item, row, device, mine } = await overlapped("caught-up");
    const report = value(await device.drain());
    expect(verdictOf(report, mine.id)).toBe("conflicted");
    expect(
      report.verdicts.find((entry) => entry.id === mine.id)?.conflicts,
    ).toEqual([{ row, column: "note" }]);
    expect(await serverRows(item)).toEqual({
      [row]: { count: 1, note: "offline" },
    });
    expect(await deviceRows(device, item)).toEqual({
      [row]: { count: 1, note: "offline" },
    });
  });

  it("reports a write conflicted where a held stream drains it once its server is back", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    await write(item, [
      { op: "put", id: row, values: { count: 1, note: "a" } },
    ]);
    counter += 1;
    const device = await BindingDevice.start({
      module: requireModule(),
      store: newStore(`table-writes-followed-${String(counter)}`),
      url: server.apiUrl,
      key: server.workingKey,
    });
    bindings.push(device);
    value(await device.hydrate([type], "library"));
    value(await device.call("holdTable", type, "steps"));
    const mine = value(
      await device.call<QueuedWrite>("writeRows", item, "steps", [
        { op: "patch", id: row, values: { note: "offline" } },
      ]),
    );
    await write(item, [{ op: "patch", id: row, values: { note: "other" } }]);
    const follow = await device.follow({ toldUnreachable: true });
    try {
      const answered = async (): Promise<string | undefined> => {
        const held = value(
          await device.call<{ id: string; verdict?: { verdict: string } }[]>(
            "queue",
          ),
        );
        return held.find((entry) => entry.id === mine.id)?.verdict?.verdict;
      };
      await until(
        async () => (await answered()) !== undefined,
        "the follow draining the write",
      );
      expect(await answered()).toBe("conflicted");
    } finally {
      expect(await follow.stop()).toBeNull();
    }
  });

  it("asks the stream for nothing where no row write waits for a table the copy holds whole", async () => {
    const proxy = await proxied();
    const { device, mine } = await overlapped("caught-up-witness", proxy.url);
    const setUp = proxy.eventRequests;
    expect(verdictOf(value(await device.drain()), mine.id)).toBe("conflicted");
    // The witness: the same drain asked for the stream.
    expect(proxy.eventRequests).toBeGreaterThan(setUp);

    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    await write(item, [{ op: "put", id: row, values: { count: 1 } }]);
    const items = await holding(
      type,
      "caught-up-items",
      server.workingKey,
      proxy.url,
    );
    const before = proxy.eventRequests;
    const made = value(
      await items.create({ type, properties: { title: "Another" } }),
    );
    expect(verdictOf(value(await items.drain()), made.id)).toBe("accepted");
    expect(proxy.eventRequests).toBe(before);

    const unheld = deviceFor("caught-up-unheld", server.workingKey, proxy.url);
    value(await unheld.hydrate([type], "library"));
    const loose = value(
      await unheld.writeRows(item, "steps", [
        { op: "patch", id: row, values: { count: 2 } },
      ]),
    );
    await write(item, [{ op: "patch", id: row, values: { count: 3 } }]);
    const afterwards = proxy.eventRequests;
    const report = value(await unheld.drain());
    expect(verdictOf(report, loose.id)).toBe("accepted");
    expect(
      report.verdicts.find((entry) => entry.id === loose.id)?.conflicts ?? [],
    ).toEqual([]);
    expect(proxy.eventRequests).toBe(afterwards);
  });

  it("sends the write and judges it by what the copy has applied where the stream cannot be had or ends before it is live", async () => {
    const proxy = await proxied();
    for (const down of ["refuse", "end"] as const) {
      const { item, row, device, mine } = await overlapped(
        `caught-up-${down}`,
        proxy.url,
      );
      proxy.events = down;
      const before = proxy.eventRequests;
      const report = value(await device.drain());
      proxy.events = null;
      expect(proxy.eventRequests, down).toBeGreaterThan(before);
      expect(verdictOf(report, mine.id), down).toBe("accepted");
      expect(
        report.verdicts.find((entry) => entry.id === mine.id)?.conflicts ?? [],
        down,
      ).toEqual([]);
      expect((await serverRows(item))[row], down).toEqual({
        count: 1,
        note: "offline",
      });
    }
  });

  it("names only the column whose value it replaced, where another writer set the other column to the value the write sets", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    await write(item, [
      { op: "put", id: row, values: { count: 1, note: "a" } },
    ]);
    const device = await holding(type, "caught-up-same");
    const mine = value(
      await device.writeRows(item, "steps", [
        { op: "patch", id: row, values: { count: 2, note: "same" } },
      ]),
    );
    await write(item, [
      { op: "patch", id: row, values: { count: 3, note: "same" } },
    ]);
    const report = value(await device.drain());
    expect(verdictOf(report, mine.id)).toBe("conflicted");
    expect(
      report.verdicts.find((entry) => entry.id === mine.id)?.conflicts,
    ).toEqual([{ row, column: "count" }]);
    expect(await serverRows(item)).toEqual({
      [row]: { count: 2, note: "same" },
    });
  });

  it("reports a write conflicted where another writer's batch reaches a following copy after its stream went live", async () => {
    const proxy = await proxied();
    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    await write(item, [
      { op: "put", id: row, values: { count: 1, note: "a" } },
    ]);
    counter += 1;
    const store = newStore(`table-writes-live-later-${String(counter)}`);
    const gate = new Gate(dirname(store), "gate-rows-event");
    const device = await BindingDevice.start({
      module: requireModule(),
      store,
      url: proxy.url,
      key: server.workingKey,
      env: gate.env,
    });
    bindings.push(device);
    value(await device.hydrate([type], "library"));
    value(await device.call("holdTable", type, "steps"));
    const mine = value(
      await device.call<QueuedWrite>("writeRows", item, "steps", [
        { op: "patch", id: row, values: { note: "offline" } },
      ]),
    );
    const follow = await device.follow();
    try {
      // An event the follow takes once its stream is open, so the next one comes after it went live.
      await write(item, [{ op: "put", id: uuidv7(), values: { count: 0 } }]);
      await until(
        () => gate.reached() === 1,
        "the follow reaching a first event",
      );
      gate.release(1);
      await write(item, [{ op: "patch", id: row, values: { note: "other" } }]);
      await until(
        () => gate.reached() === 2,
        "the follow reaching the overlap",
      );
      const before = proxy.eventRequests;
      const draining = device.call<{
        verdicts: {
          id: string;
          verdict: { verdict: string } | null;
          conflicts: { row: string; column: string }[];
        }[];
      }>("drain");
      await until(
        () => proxy.eventRequests > before,
        "the drain reading the head of the log",
      );
      // The batch's own event stays held, so the answer is judged before it.
      gate.release(2);
      const told = value(await draining).verdicts.find(
        (entry) => entry.id === mine.id,
      );
      expect(told?.verdict?.verdict).toBe("conflicted");
      expect(told?.conflicts).toEqual([{ row, column: "note" }]);
    } finally {
      gate.release("all");
      expect(await follow.stop()).toBeNull();
    }
  });

  it("sends the writes queued ahead of a row write before it waits, and sends the row write once 5 seconds pass without the stream's head", async () => {
    const proxy = await proxied();
    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    await write(item, [
      { op: "put", id: row, values: { count: 1, note: "a" } },
    ]);
    const device = await holding(
      type,
      "caught-up-silent",
      server.workingKey,
      proxy.url,
    );
    const made = value(
      await device.create({ type, properties: { title: "Ahead" } }),
    );
    const mine = value(
      await device.writeRows(item, "steps", [
        { op: "patch", id: row, values: { note: "offline" } },
      ]),
    );
    await write(item, [{ op: "patch", id: row, values: { note: "other" } }]);
    proxy.events = "silent";
    const from = proxy.asked.length;
    const started = Date.now();
    const report = value(await device.drain());
    const took = Date.now() - started;
    proxy.events = null;
    expect(verdictOf(report, made.id)).toBe("accepted");
    expect(verdictOf(report, mine.id)).toBe("accepted");
    const asked = proxy.asked.slice(from);
    const created = asked.findIndex((one) => /^POST \/items(\?|$)/.test(one));
    const stream = asked.findIndex((one) => one.startsWith("GET /events"));
    const rows = asked.findIndex((one) =>
      /^POST \/items\/[^/]+\/tables\/steps\/rows$/.test(one),
    );
    expect(created, asked.join("\n")).toBeGreaterThanOrEqual(0);
    expect(stream, asked.join("\n")).toBeGreaterThan(created);
    expect(rows, asked.join("\n")).toBeGreaterThan(stream);
    expect(took).toBeGreaterThanOrEqual(5_000);
    expect(took).toBeLessThan(10_000);
  });

  it("ends the wait 5 seconds after it began where the stream is slow to answer, whether it reads the head or catches up to it", async () => {
    const proxy = await proxied();
    for (const request of [1, 2]) {
      const { item, row, device, mine } = await overlapped(
        `caught-up-slow-${String(request)}`,
        proxy.url,
      );
      proxy.slowEventRequest = proxy.eventRequests + request;
      const started = Date.now();
      const report = value(await device.drain());
      const took = Date.now() - started;
      expect(proxy.eventRequests, String(request)).toBeGreaterThanOrEqual(
        proxy.slowEventRequest,
      );
      expect(took, String(request)).toBeLessThan(6_500);
      expect(verdictOf(report, mine.id), String(request)).toBe("accepted");
      expect((await serverRows(item))[row], String(request)).toEqual({
        count: 1,
        note: "offline",
      });
    }
  });

  it("ends the wait 5 seconds after it began where a read of a table's rows the catch-up makes is slow", async () => {
    const proxy = await proxied();
    const { item, row, device, mine } = await overlapped(
      "caught-up-slow-rows",
      proxy.url,
    );
    // Rows too large for the event to carry, so catching up reads them.
    await write(
      item,
      Array.from({ length: 100 }, () => ({
        op: "put",
        id: uuidv7(),
        values: { note: "x".repeat(1000) },
      })),
    );
    proxy.slowRowReads = true;
    const from = proxy.asked.length;
    const started = Date.now();
    const report = value(await device.drain());
    const took = Date.now() - started;
    proxy.slowRowReads = false;
    const asked = proxy.asked.slice(from);
    expect(
      asked.some((one) => /^GET \/items\/[^/]+\/tables\/steps\/rows/.test(one)),
      asked.join("\n"),
    ).toBe(true);
    expect(took).toBeLessThan(6_500);
    expect(verdictOf(report, mine.id)).toBe("accepted");
    expect((await serverRows(item))[row]).toEqual({
      count: 1,
      note: "offline",
    });
  });

  /** Two items of one type, each with a row a device holding the table whole patches, and another writer then patches. */
  async function overlappedTwice(label: string, url: string) {
    const type = await tableType();
    const items = [await itemOf(type), await itemOf(type)];
    const rows = [uuidv7(), uuidv7()];
    for (const [at, item] of items.entries())
      await write(item, [
        { op: "put", id: rows[at], values: { count: 1, note: "a" } },
      ]);
    const device = await holding(type, label, server.workingKey, url);
    const mine: QueuedWrite[] = [];
    for (const [at, item] of items.entries())
      mine.push(
        value(
          await device.writeRows(item, "steps", [
            { op: "patch", id: rows[at], values: { note: "offline" } },
          ]),
        ),
      );
    for (const [at, item] of items.entries())
      await write(item, [
        { op: "patch", id: rows[at], values: { note: "other" } },
      ]);
    return { rows, device, mine };
  }

  it("waits once in a drain, before its first row write, and judges each row write by the value the copy showed when it was made", async () => {
    const proxy = await proxied();
    const { rows, device, mine } = await overlappedTwice(
      "caught-up-once",
      proxy.url,
    );
    const from = proxy.asked.length;
    const report = value(await device.drain());
    const asked = proxy.asked.slice(from);
    const sent = asked.flatMap((one, at) =>
      /^POST \/items\/[^/]+\/tables\/steps\/rows$/.test(one) ? [at] : [],
    );
    const streams = asked.flatMap((one, at) =>
      one.startsWith("GET /events") ? [at] : [],
    );
    expect(sent, asked.join("\n")).toHaveLength(2);
    expect(streams.length, asked.join("\n")).toBeGreaterThan(0);
    expect(
      streams.every((at) => at < sent[0]),
      asked.join("\n"),
    ).toBe(true);
    for (const [at, write] of mine.entries()) {
      const told = report.verdicts.find((entry) => entry.id === write.id);
      expect(told?.verdict, String(at)).toBe("conflicted");
      expect(told?.conflicts, String(at)).toEqual([
        { row: rows[at], column: "note" },
      ]);
    }
  });

  it("waits once in a drain whose stream's head cannot be had, however many row writes it sends", async () => {
    const proxy = await proxied();
    const { device, mine } = await overlappedTwice(
      "caught-up-once-silent",
      proxy.url,
    );
    proxy.events = "silent";
    const from = proxy.asked.length;
    const started = Date.now();
    const report = value(await device.drain());
    const took = Date.now() - started;
    proxy.events = null;
    const asked = proxy.asked.slice(from);
    expect(
      asked.filter((one) => one.startsWith("GET /events")),
      asked.join("\n"),
    ).toHaveLength(1);
    expect(
      asked.filter((one) =>
        /^POST \/items\/[^/]+\/tables\/steps\/rows$/.test(one),
      ),
      asked.join("\n"),
    ).toHaveLength(2);
    for (const write of mine)
      expect(verdictOf(report, write.id)).toBe("accepted");
    expect(took).toBeGreaterThanOrEqual(5_000);
    expect(took).toBeLessThan(10_000);
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

  it("refuses every write of a batch the server refuses naming no operation, and discards them all when a caller discards one", async () => {
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

    expect(value(await device.discard(writes[1]!.id))).toBe(true);
    const left = value(await device.queue()).map((one) => one.id);
    expect(left).not.toContain(writes[0]!.id);
    expect(left).not.toContain(writes[1]!.id);
  });
});

describe("a batch the drain cannot settle at once", () => {
  /** Two writes to one row, which a drain sends in one batch. */
  async function twoWrites(label: string) {
    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    await write(item, [{ op: "put", id: row, values: { count: 1 } }]);
    const proxy = await proxied();
    const device = await holding(type, label, server.workingKey, proxy.url);
    const first = value(
      await device.writeRows(item, "steps", [
        { op: "patch", id: row, values: { count: 2 } },
      ]),
    );
    const second = value(
      await device.writeRows(item, "steps", [
        { op: "patch", id: row, values: { note: "second" } },
      ]),
    );
    const batch = {
      operations: [
        { op: "patch", id: row, values: { count: 2 } },
        { op: "patch", id: row, values: { note: "second" } },
      ],
    };
    return { type, item, row, proxy, device, first, second, batch };
  }

  async function batchesOf(item: string): Promise<number> {
    const batches = await working.rawRequest<{ data: unknown[] }>(
      `/items/${item}/tables/steps/batches`,
    );
    return batches.data.data.length;
  }

  it("sets a batch whose answer was lost aside whole under its key, telling each write once, and sends it again as it went once a caller releases one of its writes", async () => {
    const { item, row, proxy, device, first, second, batch } =
      await twoWrites("set-aside");
    value(await device.addTag(item, "witness"));
    for (let pass = 0; pass < 5; pass += 1)
      proxy.replies.push({ forward: true, lose: true });
    for (let pass = 0; pass < 3; pass += 1) value(await device.drain());
    expect(await serverRows(item)).toEqual({
      [row]: { count: 2, note: "second" },
    });
    await write(item, [{ op: "patch", id: row, values: { note: "other" } }]);
    const held = await batchesOf(item);

    const stuck = value(await drainWith(device, "clock-offset=360000"));
    for (const one of [first, second]) {
      expect(
        told(stuck, one.id).map((entry) => [entry.verdict, entry.reason]),
      ).toEqual([["blocked", "failing_alone"]]);
      expect((await queued(device, one.id)).idempotency_key).toBe(
        one.idempotency_key,
      );
    }
    expect((await queued(device, second.id)).batched_with).toBe(first.id);
    const sent = proxy.sent.length;
    value(await device.drain());
    expect(proxy.sent).toHaveLength(sent);

    expect(value(await device.release({ id: second.id }))).toBeTruthy();
    for (const one of [first, second])
      expect((await queued(device, one.id)).verdict).toBeNull();
    const again = value(await device.drain());
    expect(
      [first, second].map((one) =>
        told(again, one.id).map((entry) => [entry.verdict, entry.replayed]),
      ),
    ).toEqual([[["accepted", true]], [["accepted", true]]]);
    expect(proxy.sent).toEqual(
      proxy.sent.map(() => ({ key: first.idempotency_key, body: batch })),
    );
    expect(await serverRows(item)).toEqual({
      [row]: { count: 2, note: "other" },
    });
    expect(await batchesOf(item)).toBe(held);
  });

  it("refuses every write of a batch it sent before that the server refuses naming an operation, sending none of it again", async () => {
    const { item, row, proxy, device, first, second, batch } =
      await twoWrites("resent-refused");
    proxy.replies.push(
      { forward: true, lose: true },
      {
        forward: false,
        status: 404,
        body: JSON.stringify({
          error: {
            code: "row_not_found",
            message: "No row has that id.",
            details: { operation: 1 },
          },
        }),
      },
    );
    value(await device.drain());
    expect(await serverRows(item)).toEqual({
      [row]: { count: 2, note: "second" },
    });

    const report = value(await device.drain());
    expect([first, second].map((one) => verdictOf(report, one.id))).toEqual([
      "refused",
      "refused",
    ]);
    value(await device.drain());
    expect(proxy.sent).toEqual([
      { key: first.idempotency_key, body: batch },
      { key: first.idempotency_key, body: batch },
    ]);
    expect(await serverRows(item)).toEqual({
      [row]: { count: 2, note: "second" },
    });
  });

  it("refuses only the write whose operation the server refuses from its record for a batch it sent before, and sends the others again in the same drain", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const [kept, gone] = [uuidv7(), uuidv7()];
    await write(item, [
      { op: "put", id: kept, values: { count: 1 } },
      { op: "put", id: gone, values: { count: 2 } },
    ]);
    const proxy = await proxied();
    const device = await holding(
      type,
      "replayed-refusal",
      server.workingKey,
      proxy.url,
    );
    await write(item, [{ op: "delete", id: gone }]);
    const first = value(
      await device.writeRows(item, "steps", [
        { op: "patch", id: kept, values: { note: "kept" } },
      ]),
    );
    const second = value(
      await device.writeRows(item, "steps", [
        { op: "patch", id: gone, values: { note: "lost" } },
      ]),
    );
    const batch = {
      operations: [
        { op: "patch", id: kept, values: { note: "kept" } },
        { op: "patch", id: gone, values: { note: "lost" } },
      ],
    };
    proxy.replies.push({ forward: true, lose: true });
    value(await device.drain());
    expect(await serverRows(item)).toEqual({ [kept]: { count: 1 } });

    const report = value(await device.drain());
    expect([first, second].map((one) => verdictOf(report, one.id))).toEqual([
      "accepted",
      "refused",
    ]);
    expect(JSON.parse((await queued(device, second.id)).answer!)).toMatchObject(
      { error: { code: "row_not_found", details: { operation: 0 } } },
    );
    const fresh = (await queued(device, first.id)).idempotency_key;
    expect(fresh).not.toBe(first.idempotency_key);
    expect(proxy.sent).toEqual([
      { key: first.idempotency_key, body: batch },
      { key: first.idempotency_key, body: batch },
      { key: fresh, body: { operations: [batch.operations[0]] } },
    ]);
    expect(await serverRows(item)).toEqual({
      [kept]: { count: 1, note: "kept" },
    });
  });

  it("withdraws every write of a batch set aside whole when a caller withdraws one of them", async () => {
    const { item, row, proxy, device, first, second } =
      await twoWrites("withdrawn");
    value(await device.addTag(item, "witness"));
    proxy.refusing = { item, gateway: 413 };
    for (let pass = 0; pass < 3; pass += 1) value(await device.drain());
    const stuck = value(await drainWith(device, "clock-offset=360000"));
    expect(
      [first, second].map((one) => told(stuck, one.id)[0]?.reason),
    ).toEqual(["failing_alone", "failing_alone"]);

    expect(value(await device.withdraw(first.id))).toEqual([
      first.id,
      second.id,
    ]);
    const left = value(await device.queue()).map((one) => one.id);
    expect(left).not.toContain(first.id);
    expect(left).not.toContain(second.id);
    expect(await deviceRows(device, item)).toEqual({ [row]: { count: 1 } });
    proxy.refusing = null;
    const sent = proxy.sent.length;
    value(await device.drain());
    expect(proxy.sent).toHaveLength(sent);
    expect(await serverRows(item)).toEqual({ [row]: { count: 1 } });
  });

  it("releases every write of a dead batch when a caller releases one, and sends the batch again as it went under its key", async () => {
    const { item, row, proxy, device, first, second, batch } =
      await twoWrites("dead");
    for (let pass = 0; pass < 5; pass += 1)
      proxy.replies.push({ forward: false, status: 200, body: "{}" });
    for (let pass = 0; pass < 5; pass += 1) value(await device.drain());
    for (const one of [first, second])
      expect((await queued(device, one.id)).verdict).toBe("dead");
    expect((await queued(device, second.id)).batched_with).toBe(first.id);

    expect(value(await device.release({ id: first.id }))).toBeTruthy();
    for (const one of [first, second]) {
      const now = await queued(device, one.id);
      expect([now.verdict, now.idempotency_key]).toEqual([
        null,
        one.idempotency_key,
      ]);
    }
    const again = value(await device.drain());
    expect(
      [first, second].map((one) =>
        told(again, one.id).map((entry) => entry.verdict),
      ),
    ).toEqual([["accepted"], ["accepted"]]);
    expect(proxy.sent).toEqual(
      Array.from({ length: 6 }, () => ({
        key: first.idempotency_key,
        body: batch,
      })),
    );
    expect(await serverRows(item)).toEqual({
      [row]: { count: 2, note: "second" },
    });
  });

  it("marks every write of a batch another instance answers unsent and out of the batch, and sends them together again", async () => {
    const { type, item, row, proxy, device, first, second, batch } =
      await twoWrites("instance");
    proxy.replies.push({
      forward: false,
      status: 409,
      body: JSON.stringify({
        error: { code: "instance_changed", message: "Another instance." },
      }),
    });
    expect(refused(await device.drain()).code).toBe("copy_expired");
    for (const one of [first, second])
      expect((await queued(device, one.id)).batched_with).toBeNull();

    value(await device.hydrate([type], "library"));
    const again = value(await device.drain());
    expect(
      [first, second].map((one) =>
        told(again, one.id).map((entry) => entry.verdict),
      ),
    ).toEqual([["accepted"], ["accepted"]]);
    expect(proxy.sent).toEqual([
      { key: first.idempotency_key, body: batch },
      { key: first.idempotency_key, body: batch },
    ]);
    expect(await serverRows(item)).toEqual({
      [row]: { count: 2, note: "second" },
    });
  });

  it("counts a refusal against every write of a batch answered 200 with a body that is not the batch's answer, keeping the rows it shows, and sends it again under its key", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    await write(item, [{ op: "put", id: row, values: { count: 1 } }]);
    const proxy = await proxied();
    const device = await holding(
      type,
      "unreadable",
      server.workingKey,
      proxy.url,
    );
    const writes = [
      value(
        await device.writeRows(item, "steps", [
          { op: "patch", id: row, values: { count: 2 } },
        ]),
      ),
      value(
        await device.writeRows(item, "steps", [
          { op: "put", values: { count: 3 } },
        ]),
      ),
    ];
    const [patched, added] = writes.map(
      (one) => (one.body as { operations: { id: string }[] }).operations[0]!.id,
    );
    const shown = await deviceRows(device, item);
    expect(shown).toEqual({ [row]: { count: 2 }, [added!]: { count: 3 } });
    const unreadable: Reply[] = [
      { forward: false, status: 200, body: "{}" },
      { forward: false, status: 200, body: "not json" },
      {
        forward: true,
        status: 200,
        body: JSON.stringify({
          batch: uuidv7(),
          results: [{ id: patched, outcome: "patched" }],
        }),
      },
      {
        forward: false,
        status: 200,
        body: JSON.stringify({
          batch: uuidv7(),
          results: [
            { id: patched, outcome: "patched" },
            { id: uuidv7(), outcome: "created" },
          ],
        }),
      },
    ];
    proxy.replies.push(...unreadable);
    for (let pass = 1; pass <= unreadable.length; pass += 1) {
      const report = value(await device.drain());
      for (const one of writes) {
        const [entry] = told(report, one.id);
        expect(
          [entry?.verdict, entry?.refusals],
          `pass ${String(pass)}`,
        ).toEqual([null, pass]);
      }
      expect(await deviceRows(device, item)).toEqual(shown);
    }
    expect(value(await device.queue()).map((one) => one.verdict)).toEqual([
      null,
      null,
    ]);
    expect(await serverRows(item)).toEqual({
      [row]: { count: 2 },
      [added!]: { count: 3 },
    });

    const report = value(await device.drain());
    expect(writes.map((one) => verdictOf(report, one.id))).toEqual([
      "accepted",
      "accepted",
    ]);
    expect(told(report, writes[0]!.id)[0]?.replayed).toBe(true);
    const batches = await working.rawRequest<{ data: unknown[] }>(
      `/items/${item}/tables/steps/batches`,
    );
    expect(batches.data.data).toHaveLength(2);
  });

  it("counts a refusal against an undo answered 200 with a body that is not an undo's answer, and sends it again under its key", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    await write(item, [{ op: "put", id: row, values: { count: 1 } }]);
    const changed = await write(item, [
      { op: "patch", id: row, values: { count: 7 } },
    ]);
    const proxy = await proxied();
    const device = await holding(
      type,
      "undo-unreadable",
      server.workingKey,
      proxy.url,
    );
    const undo = value(await device.undoRows(item, "steps", changed.batch!));
    proxy.replies.push(
      { forward: false, status: 200, body: "{}" },
      {
        forward: true,
        status: 200,
        body: JSON.stringify({ batch: uuidv7(), results: "all" }),
      },
    );
    for (let pass = 1; pass <= 2; pass += 1) {
      const [entry] = told(value(await device.drain()), undo.id);
      expect([entry?.verdict, entry?.refusals]).toEqual([null, pass]);
    }
    const [entry] = told(value(await device.drain()), undo.id);
    expect([entry?.verdict, entry?.replayed]).toEqual(["accepted", true]);
    expect(await serverRows(item)).toEqual({ [row]: { count: 1 } });
  });

  it("sends a dead undo again under its key once a caller releases it, so the server answers it from its record and puts back no row deleted since", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    await write(item, [{ op: "put", id: row, values: { count: 1 } }]);
    const deleted = await write(item, [{ op: "delete", id: row }]);
    const proxy = await proxied();
    const device = await holding(
      type,
      "undo-released",
      server.workingKey,
      proxy.url,
    );
    const undo = value(await device.undoRows(item, "steps", deleted.batch!));
    for (let pass = 0; pass < 5; pass += 1)
      proxy.replies.push({ forward: true, status: 200, body: "{}" });
    for (let pass = 0; pass < 5; pass += 1) value(await device.drain());
    expect((await queued(device, undo.id)).verdict).toBe("dead");
    expect(await serverRows(item)).toEqual({ [row]: { count: 1 } });
    await write(item, [{ op: "delete", id: row }]);

    expect(value(await device.release({ id: undo.id }))).toBeTruthy();
    const [entry] = told(value(await device.drain()), undo.id);
    expect(await serverRows(item)).toEqual({});
    expect([entry?.verdict, entry?.replayed]).toEqual(["accepted", true]);
    expect((await queued(device, undo.id)).idempotency_key).toBe(
      undo.idempotency_key,
    );
  });

  it("sends an undo blocked key_spent under a fresh key once a caller releases it", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    await write(item, [{ op: "put", id: row, values: { count: 1 } }]);
    const changed = await write(item, [
      { op: "patch", id: row, values: { count: 7 } },
    ]);
    const proxy = await proxied();
    const device = await holding(
      type,
      "undo-key-spent",
      server.workingKey,
      proxy.url,
    );
    const undo = value(await device.undoRows(item, "steps", changed.batch!));
    proxy.replies.push({
      forward: false,
      status: 422,
      body: JSON.stringify({
        error: {
          code: "idempotency_key_reused",
          message: "The key names another request.",
        },
      }),
    });
    expect(told(value(await device.drain()), undo.id)[0]?.reason).toBe(
      "key_spent",
    );

    expect(value(await device.release({ id: undo.id }))).toBeTruthy();
    expect((await queued(device, undo.id)).idempotency_key).not.toBe(
      undo.idempotency_key,
    );
    const [entry] = told(value(await device.drain()), undo.id);
    expect([entry?.verdict, entry?.replayed]).toEqual(["accepted", false]);
    expect(await serverRows(item)).toEqual({ [row]: { count: 1 } });
  });

  it("counts a refusal against every write of a batch whose answer the store fails to record at a later write, and sends the same batch again under its key", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    await write(item, [{ op: "put", id: row, values: { count: 1 } }]);
    const device = await holding(type, "store-fails");
    const writes = [
      value(
        await device.writeRows(item, "steps", [
          { op: "patch", id: row, values: { count: 2 } },
        ]),
      ),
      value(
        await device.writeRows(item, "steps", [
          { op: "patch", id: row, values: { note: "b" } },
        ]),
      ),
    ];
    const failed = value(
      await drainWith(device, `store-fails-at-answer=${writes[1]!.id}`),
    );
    for (const one of writes) {
      const entries = told(failed, one.id);
      expect(entries.map((entry) => [entry.verdict, entry.refusals])).toEqual([
        [null, 1],
      ]);
      expect(entries[0]?.reason).toContain("could not take the answer");
    }
    const kept = value(await device.queue());
    expect(kept.map((one) => [one.verdict, one.batched_with])).toEqual([
      [null, null],
      [null, writes[0]!.id],
    ]);

    const report = value(await device.drain());
    expect(writes.map((one) => verdictOf(report, one.id))).toEqual([
      "accepted",
      "accepted",
    ]);
    expect(told(report, writes[1]!.id)[0]?.replayed).toBe(true);
    expect(await serverRows(item)).toEqual({ [row]: { count: 2, note: "b" } });
  });

  it("settles every write of a batch the server refuses whole once a store failure at a later write is behind it, leaving none waiting on the first", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const device = await holding(type, "refusal-fails");
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
    const failed = value(
      await drainWith(device, `store-fails-at-answer=${writes[1]!.id}`),
    );
    expect(
      writes.map((one) => told(failed, one.id).map((entry) => entry.verdict)),
    ).toEqual([[null], [null]]);
    const report = value(await device.drain());
    expect(writes.map((one) => verdictOf(report, one.id))).toEqual([
      "refused",
      "refused",
    ]);
    expect(
      value(await device.queue()).map((one) => one.refusal?.code ?? null),
    ).toEqual(["item_not_found", "item_not_found"]);
  });

  it("releases every write of a batch blocked key_spent when a caller releases one, and sends the batch as it went under a fresh key", async () => {
    const { item, row, proxy, device, first, second, batch } =
      await twoWrites("released");
    proxy.replies.push({
      forward: false,
      status: 422,
      body: JSON.stringify({
        error: {
          code: "idempotency_key_reused",
          message: "The key names another request.",
        },
      }),
    });
    const blocked = value(await device.drain());
    expect(
      [first, second].map((one) => told(blocked, one.id)[0]?.reason),
    ).toEqual(["key_spent", "key_spent"]);
    expect((await queued(device, second.id)).batched_with).toBe(first.id);

    expect(value(await device.release({ id: second.id }))).toBeTruthy();
    for (const one of [first, second])
      expect((await queued(device, one.id)).verdict).toBeNull();
    expect((await queued(device, second.id)).batched_with).toBe(first.id);
    const fresh = (await queued(device, first.id)).idempotency_key;
    expect(fresh).not.toBe(first.idempotency_key);
    const again = value(await device.drain());
    expect(
      [first, second].map((one) =>
        told(again, one.id).map((entry) => entry.verdict),
      ),
    ).toEqual([["accepted"], ["accepted"]]);
    expect(proxy.sent).toEqual([
      { key: first.idempotency_key, body: batch },
      { key: fresh, body: batch },
    ]);
    expect(await serverRows(item)).toEqual({
      [row]: { count: 2, note: "second" },
    });
  });

  it("sends a batch blocked conflict_unresolved as it went under a fresh key once a caller releases one of its writes", async () => {
    const { item, row, proxy, device, first, second, batch } =
      await twoWrites("conflicted");
    // The server keeps a 409 under the key, which applied none of the batch.
    proxy.replies.push({
      forward: false,
      status: 409,
      body: JSON.stringify({
        error: { code: "version_conflict", message: "The item moved." },
      }),
    });
    const blocked = value(await device.drain());
    expect(
      [first, second].map((one) => told(blocked, one.id)[0]?.reason),
    ).toEqual(["conflict_unresolved", "conflict_unresolved"]);

    expect(value(await device.release({ id: second.id }))).toBeTruthy();
    const fresh = (await queued(device, first.id)).idempotency_key;
    expect(
      fresh,
      "a batch the server refused under its key went back out under it, so the server answers it from its record with the refusal that stopped it",
    ).not.toBe(first.idempotency_key);
    expect((await queued(device, second.id)).batched_with).toBe(first.id);
    const again = value(await device.drain());
    expect(
      [first, second].map((one) =>
        told(again, one.id).map((entry) => entry.verdict),
      ),
    ).toEqual([["accepted"], ["accepted"]]);
    expect(proxy.sent).toEqual([
      { key: first.idempotency_key, body: batch },
      { key: fresh, body: batch },
    ]);
    expect(await serverRows(item)).toEqual({
      [row]: { count: 2, note: "second" },
    });
  });

  it("judges no conflict from a fill made after a write was sent whose answer was lost, taking the write as its own", async () => {
    const type = await tableType();
    const item = await itemOf(type);
    const row = uuidv7();
    await write(item, [{ op: "put", id: row, values: { count: 1 } }]);
    const proxy = await proxied();
    const device = await holding(
      type,
      "lost-refill",
      server.workingKey,
      proxy.url,
    );
    const mine = value(
      await device.writeRows(item, "steps", [
        { op: "patch", id: row, values: { count: 2 } },
      ]),
    );
    proxy.replies.push({ forward: true, lose: true });
    expect(told(value(await device.drain()), mine.id)[0]?.verdict).toBeNull();
    expect(await serverRows(item)).toEqual({ [row]: { count: 2 } });

    value(await device.letGoTable(type, "steps"));
    value(await device.holdTable(type, "steps"));
    expect(await deviceRows(device, item)).toEqual({ [row]: { count: 2 } });
    const [entry] = told(value(await device.drain()), mine.id);
    expect([entry?.verdict, entry?.replayed, entry?.conflicts]).toEqual([
      "accepted",
      true,
      [],
    ]);
  });
});

describe("the table an item of core.table keeps", () => {
  const COLUMNS = { name: { type: "string" }, amount: { type: "number" } };

  async function ledger(): Promise<{ id: string; version: number }> {
    const made = await working.createItem({
      type: "core.table",
      properties: { title: "Ledger", columns: COLUMNS },
    } as never);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    return made.data.item;
  }

  async function ownRows(item: string): Promise<Record<string, unknown>> {
    const answer = await working.rawRequest<{ data: Row[] }>(
      `/items/${item}/tables/table/rows?limit=1000`,
    );
    expect(answer.status, JSON.stringify(answer.error)).toBe(200);
    return Object.fromEntries(
      answer.data.data.map((row) => [row.id, row.values]),
    );
  }

  async function heldRows(
    device: CliDevice,
    item: string,
    ...asked: string[]
  ): Promise<Page> {
    return value(
      await device.tableRead<Page>([
        "list",
        item,
        "table",
        "--limit",
        "1000",
        ...asked,
      ]),
    );
  }

  it("holds, fills, follows, reads and writes the table an item keeps, by the item's columns as they last changed", async () => {
    const item = await ledger();
    const first = uuidv7();
    const own = await working.writeRows(item.id, "table", {
      operations: [
        { op: "put", id: first, values: { name: "rent", amount: 5 } },
      ],
    });
    expect(own.status, JSON.stringify(own.error)).toBe(200);
    const device = deviceFor("own-table");
    value(await device.hydrate(["core.table"], "library"));
    expect(
      value(await device.holdTable("core.table", "table")).fill,
    ).toMatchObject({ whole: 1 });
    const filled = await heldRows(device, item.id);
    expect(filled.held).toBe(true);
    expect(filled.data.map((row) => row.values)).toEqual([
      { name: "rent", amount: 5 },
    ]);

    const second = uuidv7();
    const more = await working.writeRows(item.id, "table", {
      operations: [
        { op: "put", id: second, values: { name: "food", amount: 2 } },
      ],
    });
    expect(more.status, JSON.stringify(more.error)).toBe(200);
    value(await device.catchUp());
    const sorted = await heldRows(device, item.id, "--sort", "values.amount");
    expect(sorted.held).toBe(true);
    expect(sorted.data.map((row) => row.id)).toEqual([second, first]);

    const unknown = refused(
      await device.writeRows(item.id, "table", [
        { op: "patch", id: first, values: { paid: true } },
      ]),
    );
    expect(unknown.code).toBe("validation");
    expect(unknown.raw).toContain("operations.0.values.paid");

    const columns = { ...COLUMNS, paid: { type: "boolean" } };
    const changed = await working.updateItem(item.id, {
      properties: { columns },
      version: item.version,
    } as never);
    expect(changed.status, JSON.stringify(changed.error)).toBe(200);
    value(await device.catchUp());
    const mine = value(
      await device.writeRows(item.id, "table", [
        { op: "patch", id: first, values: { paid: true } },
      ]),
    );
    const paid = await heldRows(
      device,
      item.id,
      "--filter",
      "values.paid eq true",
    );
    expect(paid.held).toBe(true);
    expect(paid.data.map((row) => row.values)).toEqual([
      { name: "rent", amount: 5, paid: true },
    ]);
    expect(verdictOf(value(await device.drain()), mine.id)).toBe("accepted");
    expect(await ownRows(item.id)).toEqual({
      [first]: { name: "rent", amount: 5, paid: true },
      [second]: { name: "food", amount: 2 },
    });
  });

  it("keeps a refused write's refusal numbered by the write's own operation, in its message and in every error's path", async () => {
    const withPaid = { ...COLUMNS, paid: { type: "boolean" } };
    const made = await working.createItem({
      type: "core.table",
      properties: { title: "Ledger", columns: withPaid },
    } as never);
    expect(made.status, JSON.stringify(made.error)).toBe(201);
    const item = made.data.item;
    const row = uuidv7();
    const own = await working.writeRows(item.id, "table", {
      operations: [{ op: "put", id: row, values: { name: "rent", amount: 5 } }],
    });
    expect(own.status, JSON.stringify(own.error)).toBe(200);
    const device = deviceFor("own-refusal");
    value(await device.hydrate(["core.table"], "library"));
    value(await device.holdTable("core.table", "table"));

    const writes = [];
    for (const amount of [6, 7, 8, 9])
      writes.push(
        value(
          await device.writeRows(item.id, "table", [
            { op: "patch", id: row, values: { amount } },
          ]),
        ),
      );
    writes.push(
      value(
        await device.writeRows(item.id, "table", [
          { op: "patch", id: row, values: { paid: true } },
        ]),
      ),
    );
    const removed = await working.updateItem(item.id, {
      properties: { columns: COLUMNS },
      version: item.version,
    } as never);
    expect(removed.status, JSON.stringify(removed.error)).toBe(200);

    const report = value(await device.drain());
    expect(writes.map((one) => verdictOf(report, one.id))).toEqual([
      "accepted",
      "accepted",
      "accepted",
      "accepted",
      "refused",
    ]);
    const refusal = JSON.parse((await queued(device, writes[4]!.id)).answer!);
    expect(refusal.error).toMatchObject({
      code: "validation_error",
      message: "operations.0.values.paid: The table declares no such column",
      details: {
        operation: 0,
        errors: [
          {
            path: "operations.0.values.paid",
            message: "The table declares no such column",
          },
        ],
      },
    });
  });
});
