import { createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { statSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { bootServer, stopServer } from "../marfa-server.js";
import { openEventStream, parseSse } from "../../src/utils/sse.js";
import { controlRequest } from "../../src/utils/control-request.js";
import { parseEnvFile } from "../../src/utils/target.js";
import {
  distribution,
  scalar,
  type Figure,
} from "../../src/utils/scale/figures.js";
import { readServerMemory } from "../../src/utils/scale/memory.js";
import { percentile } from "../../src/utils/timing.js";
import {
  log,
  ok,
  Recorder,
  sleep,
  type Answer,
  type Connection,
} from "./context.js";

const TABLE = "readings";
// Polling stays below the default limit of 4,000 requests per key per minute.
const POLL_GAP_MS = 20;
const ORDER_BUDGET_MS = 30_000;
const TOTAL_RUNS = 30;
const READER_KEYS = 7;
const STALL_MS = 500;
const UNDO_REPEATS = 5;
const PURGE_NUDGE_MS = 60_000;
const PURGE_LIMIT_MS = 600_000;
const WRITE_FLOOR = 20_000;

// Retrying a rate-limit refusal would hide it from the measurement.
async function send(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body: string | object | undefined,
  connection: Connection,
): Promise<Answer> {
  const payload =
    body === undefined || typeof body === "string"
      ? body
      : JSON.stringify(body);
  const start = performance.now();
  let status = 0;
  let text = "";
  try {
    const response = await fetch(`${connection.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${connection.key}`,
        ...(payload === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: payload,
      signal: AbortSignal.timeout(900_000),
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    text = String(error);
  }
  return {
    status,
    ms: performance.now() - start,
    text,
    json: () => JSON.parse(text) as unknown,
  };
}

interface Options {
  rows: number;
  pace: number;
  page: number;
  server: string;
  state: string | null;
}

function options(): Options {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      rows: { type: "string", default: "1000000" },
      pace: { type: "string", default: "25000" },
      page: { type: "string", default: "1000" },
      server: { type: "string", default: process.env.MARFA_SERVER_BIN ?? "" },
      state: { type: "string" },
    },
  });
  const whole = (name: string, raw: string, least: number) => {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < least) {
      throw new Error(
        `--${name} is ${raw}; it needs a whole number of ${least} or more`,
      );
    }
    return value;
  };
  const page = whole("page", values.page, 1);
  if (page > 1000)
    throw new Error("--page is at most 1000, the most rows a batch holds");
  const rows = whole("rows", values.rows, page);
  if (values.server === "") {
    throw new Error(
      "--server names the marfa-server program to measure (or set MARFA_SERVER_BIN)",
    );
  }
  return {
    rows,
    pace: whole("pace", values.pace, 0),
    page,
    server: resolve(values.server),
    state: values.state === undefined ? null : resolve(values.state),
  };
}

interface Reading {
  times: number[];
  errors: number;
}

function startReaders(
  readers: Record<
    string,
    { connection: Connection; path: (i: number) => string | null }
  >,
): { stop: () => Promise<Record<string, Reading>> } {
  let running = true;
  const readings: Record<string, Reading> = {};
  const tasks = Object.entries(readers).map(
    async ([name, { connection, path }]) => {
      const reading: Reading = { times: [], errors: 0 };
      readings[name] = reading;
      for (let i = 0; running; i++) {
        const target = path(i);
        if (target === null) {
          await sleep(POLL_GAP_MS);
          continue;
        }
        const answer = await send("GET", target, undefined, connection);
        if (ok(answer)) reading.times.push(answer.ms);
        else reading.errors++;
        await sleep(POLL_GAP_MS);
      }
    },
  );
  return {
    stop: async () => {
      running = false;
      await Promise.all(tasks);
      return readings;
    },
  };
}

function followStream(connection: Connection, itemId: string) {
  const arrivals = new Map<string, number>();
  const live = { ms: Number.NaN };
  let close = async () => {};
  let ended: Promise<void> = Promise.resolve();
  const opened = performance.now();
  const ready = (async () => {
    const stream = await openEventStream(connection.url, connection.key, {
      connectTimeoutMs: 30_000,
    });
    close = () => stream.close();
    ended = (async () => {
      const body = stream.response.body;
      if (body === null) return;
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (value) {
            const at = performance.now();
            pending += decoder.decode(value, { stream: true });
            const end = pending.lastIndexOf("\n\n");
            if (end >= 0) {
              for (const event of parseSse(pending.slice(0, end + 2))) {
                if (event.event === "stream_live" && Number.isNaN(live.ms)) {
                  live.ms = at - opened;
                } else if (event.event === "rows.changed") {
                  const frame = event.data as {
                    item?: { id?: string };
                    batch?: string;
                  };
                  if (
                    frame.item?.id === itemId &&
                    typeof frame.batch === "string"
                  ) {
                    arrivals.set(frame.batch, at);
                  }
                }
              }
              pending = pending.slice(end + 2);
            }
          }
          if (done) break;
        }
      } catch {
        // Closing the subscription rejects a pending read.
      }
    })();
  })();
  return {
    ready,
    live,
    arrivals,
    stop: async () => {
      await ready;
      await close();
      await ended;
    },
  };
}

function rowOf(n: number, buckets: number) {
  const sensor = n % 64;
  return {
    sensor: `s-${sensor}`,
    reading: ((n * 7919) % 100_000) / 100,
    bucket: n % buckets,
    note: `Reading ${n} from sensor ${sensor}, steady`,
  };
}

const tableBody = (first: number, count: number, buckets: number) =>
  JSON.stringify({
    operations: Array.from({ length: count }, (_, i) => ({
      op: "put",
      values: rowOf(first + i, buckets),
    })),
  });

interface WriteAnswer {
  batch: string | null;
  results: { id: string; outcome: string }[];
}

function judgeWrite(
  answer: { status: number; text: string; json: () => unknown },
  size: number,
) {
  if (answer.status !== 200) {
    return {
      written: [] as string[],
      batch: null,
      errors: size,
      note: `${answer.status}: ${answer.text.slice(0, 160)}`,
    };
  }
  const parsed = answer.json() as WriteAnswer;
  const created = parsed.results.filter((r) => r.outcome === "created");
  return {
    written: created.map((r) => r.id),
    batch: parsed.batch,
    errors: size - created.length,
    note: null as string | null,
  };
}

interface Walk {
  times: number[];
  errors: number;
  ids: string[];
  /** The first row of each page, to name a range of the table. */
  firsts: string[];
}

async function walk(
  connection: Connection,
  itemId: string,
  query: string,
  pages: number,
  keepIds = false,
  budgetMs = Number.POSITIVE_INFINITY,
): Promise<Walk> {
  const base = `/items/${itemId}/tables/${TABLE}/rows?limit=1000&${query}`;
  await send("GET", base, undefined, connection);
  const result: Walk = { times: [], errors: 0, ids: [], firsts: [] };
  let cursor: string | null = null;
  const started = performance.now();
  for (let page = 0; page < pages; page++) {
    if (performance.now() - started > budgetMs) break;
    const answer = await send(
      "GET",
      cursor === null ? base : `${base}&cursor=${encodeURIComponent(cursor)}`,
      undefined,
      connection,
    );
    if (!ok(answer)) {
      result.errors++;
      log(
        `page ${page} of ${query}: ${answer.status} ${answer.text.slice(0, 160)}`,
      );
      break;
    }
    result.times.push(answer.ms);
    const body = answer.json() as {
      data: { id: string }[];
      next_cursor: string | null;
    };
    if (keepIds && result.ids.length === 0)
      result.ids = body.data.map((r) => r.id);
    if (keepIds && body.data[0] !== undefined)
      result.firsts.push(body.data[0].id);
    cursor = body.next_cursor;
    if (cursor === null) break;
  }
  return result;
}

function connectionOf(
  state: string,
  key: "MARFA_API_KEY" | "MARFA_MANAGEMENT_KEY",
): Connection {
  const env = parseEnvFile(readFileSync(join(state, "env"), "utf8"));
  const url = env.MARFA_API_URL;
  const secret = env[key];
  if (!url || !secret)
    throw new Error(`${state}/env names no server and ${key}`);
  return { url: url.replace(/\/$/, ""), key: secret };
}

const supervisor = (state: string) =>
  Number(readFileSync(join(state, "server.pid"), "utf8").trim());
const megabytes = (path: string) => {
  try {
    return statSync(path).size / 1_048_576;
  } catch {
    return 0;
  }
};

async function mustOk(
  what: string,
  answer: { status: number; text: string },
  status = 200,
) {
  if (answer.status !== status) {
    throw new Error(
      `${what} answered ${answer.status}: ${answer.text.slice(0, 300)}`,
    );
  }
}

interface Goal {
  text: string;
  verdict: (figure: Figure) => boolean | null;
}

export async function tables(): Promise<void> {
  const opts = options();
  const recorder = new Recorder("tables");
  const goals = new Map<string, Goal>();
  const figures: Figure[] = [];
  const add = (figure: Figure, goal: Goal) => {
    figures.push(recorder.add(figure));
    goals.set(figure.name, goal);
  };
  const upTo = (text: string) => ({ text, verdict: (f: Figure) => f.passed });
  const recordedOnly = (text: string) => ({ text, verdict: () => null });

  const work = opts.state ?? mkdtempSync(join(tmpdir(), "marfa-scale-tables-"));
  const stateA = join(work, "a");
  const stateB = join(work, "b");
  const exportFile = join(work, "export.tar");
  process.env.MARFA_SERVER_BIN = opts.server;
  const settings = { MARFA_TEST_HOOKS: "false" };

  const loads: number[] = [];
  const sample = () => loads.push(loadavg()[0] ?? 0);
  sample();
  const sampler = setInterval(sample, 10_000);
  log(
    `load average at the start: ${loadavg()
      .map((n) => n.toFixed(2))
      .join(" ")} on ${cpus().length} cores`,
  );

  const report = () => {
    const sorted = [...loads].sort((a, b) => a - b);
    console.log("");
    console.log(
      `load average (1 minute) while it ran: mean ${(loads.reduce((a, b) => a + b, 0) / loads.length).toFixed(1)}, p95 ${percentile(sorted, 95).toFixed(1)}, max ${(sorted.at(-1) ?? 0).toFixed(1)} on ${cpus().length} cores`,
    );
    console.log(
      "| figure | p50 | value (p95 for a distribution) | goal | verdict |",
    );
    console.log("|---|---|---|---|---|");
    for (const figure of figures) {
      const goal = goals.get(figure.name);
      const verdict = goal?.verdict(figure);
      const text =
        figure.errors > 0
          ? `ERRORS ${figure.errors}`
          : verdict === null || verdict === undefined
            ? "recorded"
            : verdict
              ? "met"
              : "MISSED";
      console.log(
        `| ${figure.name} | ${figure.p50 === null ? "" : figure.p50.toFixed(2)} | ${figure.value.toFixed(2)} ${figure.unit} | ${goal?.text ?? ""} | ${text}${figure.note === null ? "" : ` (${figure.note})`} |`,
      );
    }
    if (figures.some((figure) => figure.errors > 0)) process.exitCode = 1;
  };

  try {
    await bootServer({ state: stateA, env: settings });
    const connection = connectionOf(stateA, "MARFA_API_KEY");
    const management = connectionOf(stateA, "MARFA_MANAGEMENT_KEY");
    log(
      `rows ${opts.rows}, pace ${opts.pace === 0 ? "unthrottled" : `${opts.pace} rows/s`}, pages of ${opts.page}`,
    );

    const type = "user.scale-readings";
    const registered = await send(
      "POST",
      "/types",
      {
        id: type,
        fields: { title: { type: "string" } },
        tables: {
          [TABLE]: {
            label: "Readings",
            columns: {
              sensor: { type: "string" },
              reading: { type: "number", adds_up: "sum" },
              bucket: { type: "integer" },
              note: { type: "string" },
            },
          },
        },
      },
      connection,
    );
    await mustOk("registering the type", registered, 201);
    const makeItem = async (title: string) => {
      const made = await send(
        "POST",
        "/items",
        { type, properties: { title } },
        connection,
      );
      await mustOk("creating an item", made, 201);
      return (made.json() as { item: { id: string } }).item.id;
    };
    // Separate keys prevent one reader from using another reader's rate limit.
    let minted = 0;
    const readerKeys: Connection[] = [];
    for (let n = 0; n < READER_KEYS; n++) {
      const made = await send(
        "POST",
        "/keys",
        {
          label: `scale reader ${n}`,
          source: `scale-reader-${n}`,
          type_permissions: { [type]: "read" },
        },
        connection,
      );
      await mustOk("minting a reader's key", made, 201);
      readerKeys.push({
        url: connection.url,
        key: (made.json() as { key: string }).key,
      });
    }
    const reader = (): Connection => {
      const next = readerKeys[minted++];
      if (next === undefined) throw new Error("more readers than keys");
      return next;
    };
    const itemId = await makeItem("Readings");
    const tablePath = `/items/${itemId}/tables/${TABLE}`;
    const buckets = Math.max(1, Math.round(opts.rows / 100_000));

    const idPool: string[] = [];
    const acks = new Map<string, number>();
    const stream = followStream(reader(), itemId);
    await stream.ready;
    const readers = startReaders({
      item: { connection: reader(), path: () => `/items/${itemId}` },
      row_page: {
        connection: reader(),
        path: () => `${tablePath}/rows?limit=100`,
      },
      row: {
        connection: reader(),
        path: (i) =>
          idPool.length === 0
            ? null
            : `${tablePath}/rows/${idPool[(i * 13) % idPool.length]}`,
      },
      tables: { connection: reader(), path: () => `/items/${itemId}/tables` },
    });
    const pages = Math.ceil(opts.rows / opts.page);
    const pageTimes: number[] = [];
    const stalls: string[] = [];
    let written = 0;
    let writeErrors = 0;
    let failedPages = 0;
    const startedWriting = performance.now();
    for (let p = 0; p < pages; p++) {
      const first = p * opts.page;
      const count = Math.min(opts.page, opts.rows - first);
      if (opts.pace > 0) {
        const wait =
          startedWriting + (first * 1000) / opts.pace - performance.now();
        if (wait > 0) await sleep(wait);
      }
      const body = tableBody(first, count, buckets);
      const answer = await send("POST", `${tablePath}/rows`, body, connection);
      const judged = judgeWrite(answer, count);
      if (judged.batch !== null) acks.set(judged.batch, performance.now());
      written += judged.written.length;
      writeErrors += judged.errors;
      pageTimes.push(answer.ms);
      if (answer.ms > STALL_MS) {
        stalls.push(`page ${p} took ${Math.round(answer.ms)} ms`);
        log(`page ${p} took ${Math.round(answer.ms)} ms`);
      }
      if (idPool.length < 5_000) idPool.push(...judged.written);
      if (judged.errors > 0) {
        log(`page ${p}: ${judged.note ?? `${judged.errors} rows not created`}`);
        if (++failedPages >= 5)
          throw new Error("five pages failed; the run stops");
      }
      if ((p + 1) % 100 === 0) {
        log(
          `${(p + 1) * opts.page} rows written; load ${loadavg()[0]?.toFixed(2)}`,
        );
      }
    }
    const writeSeconds = (performance.now() - startedWriting) / 1000;
    const during = await readers.stop();
    await sleep(500);
    await stream.stop();

    add(
      scalar("tables_write_rate", "per_s", written / writeSeconds, {
        errors: writeErrors,
        note: `${written} rows in ${writeSeconds.toFixed(1)} s${opts.pace === 0 ? "" : ` at a pace of ${opts.pace} rows/s`}`,
      }),
      {
        text: `at least ${WRITE_FLOOR} rows/s`,
        verdict: (f) => f.errors === 0 && f.value >= WRITE_FLOOR,
      },
    );
    add(
      distribution("tables_write_page", "ms", pageTimes, {
        errors: writeErrors,
        note: `slowest ${Math.round(Math.max(...pageTimes))} ms; ${stalls.length} pages over ${STALL_MS} ms${stalls.length === 0 ? "" : ` (${stalls.slice(0, 5).join(", ")})`}`,
      }),
      recordedOnly("recorded"),
    );
    const readFigure = (key: string, figure: string) => {
      const reading = during[key] as Reading;
      add(
        distribution(figure, "ms", reading.times, { errors: reading.errors }),
        upTo("p95 10 ms"),
      );
    };
    readFigure("item", "tables_read_item_during_write");
    readFigure("row_page", "tables_read_row_page_during_write");
    readFigure("row", "tables_read_row_during_write");
    readFigure("tables", "tables_read_tables_during_write");
    const lags: number[] = [];
    for (const [batch, arrived] of stream.arrivals) {
      const acked = acks.get(batch);
      if (acked !== undefined) lags.push(Math.max(0, arrived - acked));
    }
    add(
      distribution("tables_stream_lag_during_write", "ms", lags, {
        errors: Math.max(0, pages - stream.arrivals.size),
        note: `${stream.arrivals.size} of ${pages} batch frames reached the stream; lag is from the write's answer to the frame, 0 when the frame came first`,
      }),
      upTo("p95 10 ms"),
    );
    add(
      scalar("tables_stream_live", "ms", stream.live.ms),
      recordedOnly("recorded"),
    );
    add(
      scalar("tables_rows_written", "count", written, { errors: writeErrors }),
      recordedOnly("recorded"),
    );

    const summary = await send(
      "GET",
      `/items/${itemId}/tables`,
      undefined,
      connection,
    );
    await mustOk("listing the tables", summary);
    const held = (
      summary.json() as { data: { name: string; row_count: number }[] }
    ).data.find((t) => t.name === TABLE)?.row_count;
    if (held !== opts.rows)
      throw new Error(`the table holds ${String(held)} rows, not ${opts.rows}`);
    const memory = readServerMemory(supervisor(stateA));
    add(
      scalar("tables_rss_after_write", "MB", memory.rssMb),
      recordedOnly("recorded"),
    );
    add(
      scalar(
        "tables_db_size",
        "MB",
        megabytes(join(stateA, "marfa.db")) +
          megabytes(join(stateA, "marfa.db-wal")),
        {
          note: `${((megabytes(join(stateA, "marfa.db")) * 1_048_576) / opts.rows).toFixed(0)} bytes a row in the main file`,
        },
      ),
      recordedOnly("recorded"),
    );
    log(
      `load average after the write: ${loadavg()
        .map((n) => n.toFixed(2))
        .join(" ")}`,
    );

    const byId = await walk(connection, itemId, "", pages, true);
    add(
      distribution("tables_page_by_id", "ms", byId.times, {
        errors: byId.errors,
        note: `${byId.times.length} pages, the whole table by cursor`,
      }),
      upTo("p95 20 ms"),
    );
    const byUpdated = await walk(
      connection,
      itemId,
      "sort=updated_at",
      pages,
      false,
      ORDER_BUDGET_MS,
    );
    add(
      distribution("tables_page_by_updated_at", "ms", byUpdated.times, {
        errors: byUpdated.errors,
        note: `${byUpdated.times.length} pages by cursor from the start, sorted by updated_at`,
      }),
      upTo("p95 20 ms"),
    );
    const byColumn = await walk(
      connection,
      itemId,
      "sort=values.reading",
      pages,
      false,
      ORDER_BUDGET_MS,
    );
    add(
      distribution("tables_page_by_column", "ms", byColumn.times, {
        errors: byColumn.errors,
        note: `${byColumn.times.length} pages by cursor from the start, sorted by a column`,
      }),
      recordedOnly("a known limit, about 480 ms"),
    );
    const filtered = await walk(
      connection,
      itemId,
      `filter=${encodeURIComponent("values.bucket eq 3")}`,
      pages,
      false,
      ORDER_BUDGET_MS,
    );
    add(
      distribution("tables_page_filtered", "ms", filtered.times, {
        errors: filtered.errors,
        note: `${filtered.times.length} pages of one bucket, by id`,
      }),
      recordedOnly("recorded"),
    );

    const totals = async (
      path: string,
      filter: (run: number) => string,
      runs: number,
    ) => {
      const times: number[] = [];
      let errors = 0;
      let selected = 0;
      for (let run = -3; run < runs; run++) {
        const query = filter(Math.abs(run));
        const answer = await send(
          "GET",
          `${path}/totals${query === "" ? "" : `?filter=${encodeURIComponent(query)}`}`,
          undefined,
          connection,
        );
        if (!ok(answer)) {
          errors++;
          continue;
        }
        if (run >= 0) {
          times.push(answer.ms);
          selected = (answer.json() as { row_count: number }).row_count;
        }
      }
      return { times, errors, selected };
    };
    const hundred = await makeItem("A table of 100,000 rows");
    const hundredPath = `/items/${hundred}/tables/${TABLE}`;
    for (let page = 0; page < 100; page++) {
      const filled = judgeWrite(
        await send(
          "POST",
          `${hundredPath}/rows`,
          tableBody(page * 1000, 1000, buckets),
          connection,
        ),
        1000,
      );
      if (filled.errors > 0)
        throw new Error("filling the 100,000-row table failed");
    }
    const small = await totals(hundredPath, () => "", TOTAL_RUNS);
    add(
      distribution("tables_total_100k", "ms", small.times, {
        errors: small.errors,
        note: `each total over a table of ${small.selected} rows`,
      }),
      upTo("p95 50 ms"),
    );
    const byBucket = await totals(
      tablePath,
      (run) => `values.bucket eq ${run % buckets}`,
      TOTAL_RUNS,
    );
    add(
      distribution("tables_total_100k_by_column", "ms", byBucket.times, {
        errors: byBucket.errors,
        note: `each total over the ${byBucket.selected} rows of one bucket, picked by a column of a ${opts.rows}-row table`,
      }),
      recordedOnly("recorded"),
    );
    const from = byId.firsts[100];
    const to = byId.firsts[200];
    if (from !== undefined && to !== undefined) {
      const byRange = await totals(
        tablePath,
        () => `id gte "${from}" AND id lt "${to}"`,
        TOTAL_RUNS,
      );
      add(
        distribution("tables_total_100k_by_id", "ms", byRange.times, {
          errors: byRange.errors,
          note: `each total over ${byRange.selected} rows picked by a range of ids of a ${opts.rows}-row table`,
        }),
        recordedOnly("recorded"),
      );
    }
    const everything = await totals(tablePath, () => "", 5);
    add(
      distribution("tables_total_all", "ms", everything.times, {
        errors: everything.errors,
        note: `over all ${everything.selected} rows`,
      }),
      recordedOnly("recorded"),
    );

    // An export leaves out a trashed item, so the export below is of one table.
    await mustOk(
      "trashing the 100,000-row table's item",
      await send("DELETE", `/items/${hundred}`, undefined, connection),
    );

    const undoInsert: number[] = [];
    const undoPatch: number[] = [];
    const patchTimes: number[] = [];
    let undoErrors = 0;
    const undo = async (batch: string, into: number[]) => {
      const answer = await send(
        "POST",
        `${tablePath}/batches/${batch}/undo`,
        undefined,
        connection,
      );
      if (!ok(answer)) {
        undoErrors++;
        log(`undo of ${batch}: ${answer.status} ${answer.text.slice(0, 160)}`);
        return null;
      }
      into.push(answer.ms);
      return (answer.json() as { batch: string | null }).batch;
    };
    const batchRows = Math.min(1000, opts.rows);
    for (let repeat = 0; repeat < UNDO_REPEATS; repeat++) {
      const inserted = judgeWrite(
        await send(
          "POST",
          `${tablePath}/rows`,
          tableBody(opts.rows + repeat * batchRows, batchRows, buckets),
          connection,
        ),
        batchRows,
      );
      if (inserted.batch === null) {
        undoErrors++;
        continue;
      }
      const undone = await undo(inserted.batch, undoInsert);
      if (undone !== null) {
        const redone = await undo(undone, undoInsert);
        if (redone !== null) await undo(redone, undoInsert);
      }
      const ids = byId.ids.slice(0, batchRows);
      const patch = await send(
        "POST",
        `${tablePath}/rows`,
        JSON.stringify({
          operations: ids.map((id) => ({
            op: "patch",
            id,
            values: { note: `patched ${repeat}` },
          })),
        }),
        connection,
      );
      if (!ok(patch)) {
        undoErrors++;
        continue;
      }
      patchTimes.push(patch.ms);
      const patchBatch = (patch.json() as { batch: string | null }).batch;
      if (patchBatch !== null) await undo(patchBatch, undoPatch);
    }
    add(
      distribution("tables_undo_insert_batch", "ms", undoInsert, {
        errors: undoErrors,
        note: `${batchRows} rows; the undo of an insert, of its undo, and of that`,
      }),
      recordedOnly("recorded"),
    );
    add(
      distribution("tables_undo_patch_batch", "ms", undoPatch, {
        note: `${batchRows} rows patched, then undone`,
      }),
      recordedOnly("recorded"),
    );
    add(
      distribution("tables_patch_batch", "ms", patchTimes, {
        note: `${batchRows} rows patched`,
      }),
      recordedOnly("recorded"),
    );
    const afterUndo = await send(
      "GET",
      `/items/${itemId}/tables`,
      undefined,
      connection,
    );
    const afterCount = (
      afterUndo.json() as { data: { name: string; row_count: number }[] }
    ).data.find((t) => t.name === TABLE)?.row_count;
    if (afterCount !== opts.rows) {
      throw new Error(
        `after the undos the table holds ${String(afterCount)} rows, not ${opts.rows}`,
      );
    }
    const totalsBefore = (
      await send("GET", `${tablePath}/totals`, undefined, connection)
    ).text;

    const exportStarted = performance.now();
    const exported = await fetch(
      `${connection.url}/export?format=archive&type=${encodeURIComponent(type)}`,
      {
        headers: { Authorization: `Bearer ${connection.key}` },
        signal: AbortSignal.timeout(900_000),
      },
    );
    if (exported.status !== 200 || exported.body === null) {
      throw new Error(`the export answered ${exported.status}`);
    }
    await pipeline(
      Readable.fromWeb(exported.body as never),
      createWriteStream(exportFile),
    );
    const exportSeconds = (performance.now() - exportStarted) / 1000;
    add(scalar("tables_export", "s", exportSeconds), upTo("30 s"));
    add(
      scalar("tables_export_size", "MB", megabytes(exportFile)),
      recordedOnly("recorded"),
    );

    await bootServer({ state: stateB, env: settings });
    const restoreInto = connectionOf(stateB, "MARFA_API_KEY");
    const archive = readFileSync(exportFile);
    const socket = parseEnvFile(
      readFileSync(join(stateB, "env"), "utf8"),
    ).MARFA_CONTROL_SOCKET;
    if (!socket) throw new Error(`${stateB}/env names no private socket`);
    const restoreStarted = performance.now();
    const restored = await controlRequest(socket, "/restore", {
      method: "POST",
      body: new Uint8Array(archive),
    });
    const restoreSeconds = (performance.now() - restoreStarted) / 1000;
    if (restored.status !== 200) {
      throw new Error(
        `the restore answered ${restored.status}: ${JSON.stringify(restored.body).slice(0, 300)}`,
      );
    }
    add(scalar("tables_restore", "s", restoreSeconds), upTo("30 s"));
    const restoredTables = await send(
      "GET",
      `/items/${itemId}/tables`,
      undefined,
      restoreInto,
    );
    const restoredCount =
      restoredTables.status === 200
        ? (
            restoredTables.json() as {
              data: { name: string; row_count: number }[];
            }
          ).data.find((t) => t.name === TABLE)?.row_count
        : undefined;
    const restoredTotals = (
      await send(
        "GET",
        `/items/${itemId}/tables/${TABLE}/totals`,
        undefined,
        restoreInto,
      )
    ).text;
    const sameTotals = restoredTotals === totalsBefore;
    add(
      scalar("tables_rows_restored", "count", restoredCount ?? 0, {
        errors: restoredCount === opts.rows && sameTotals ? 0 : 1,
        note: sameTotals
          ? "totals match the source"
          : "totals differ from the source",
      }),
      recordedOnly("every row, and the same totals"),
    );
    log(
      `load average after the restore: ${loadavg()
        .map((n) => n.toFixed(2))
        .join(" ")}`,
    );

    const other = await makeItem("Other");
    const otherWrite = await send(
      "POST",
      `/items/${other}/tables/${TABLE}/rows`,
      tableBody(0, Math.min(1000, opts.rows), buckets),
      connection,
    );
    await mustOk("writing the other item's rows", otherWrite);
    const purgeReaders = startReaders({
      item: { connection: reader(), path: () => `/items/${other}` },
      row_page: {
        connection: reader(),
        path: () => `/items/${other}/tables/${TABLE}/rows?limit=100`,
      },
    });
    await mustOk(
      "trashing the item",
      await send("DELETE", `/items/${itemId}`, undefined, connection),
    );
    const purgedAt = new Date().toISOString();
    const purgeStarted = performance.now();
    const purged = await send(
      "POST",
      `/items/${itemId}/purge`,
      undefined,
      connection,
    );
    const purgeRequest = purged.ms;
    await mustOk("purging the item", purged);
    let removed = 0;
    let cleaned = false;
    let nudged = false;
    while (performance.now() - purgeStarted < PURGE_LIMIT_MS && !cleaned) {
      const jobs = await send("GET", "/housekeeping", undefined, management);
      const job = ok(jobs)
        ? (
            jobs.json() as {
              data: {
                name: string;
                last_started_at?: string | null;
                last_finished_at?: string | null;
                running_since?: string | null;
                last_outcome?: string | null;
                last_result?: { removed?: number } | null;
              }[];
            }
          ).data.find((j) => j.name === "table-row-cleanup")
        : undefined;
      if (
        job?.last_started_at &&
        job.last_started_at > purgedAt &&
        job.last_finished_at &&
        !job.running_since
      ) {
        removed = job.last_result?.removed ?? 0;
        cleaned = job.last_outcome === "ok";
        break;
      }
      if (
        !nudged &&
        performance.now() - purgeStarted > PURGE_NUDGE_MS &&
        !job?.running_since
      ) {
        nudged = true;
        log(
          "the cleanup had not started a minute after the purge; asking for it",
        );
        void send(
          "POST",
          "/housekeeping/table-row-cleanup/run",
          undefined,
          management,
        );
      }
      await sleep(100);
    }
    const cleanupSeconds = (performance.now() - purgeStarted) / 1000;
    const duringPurge = await purgeReaders.stop();
    add(
      scalar("tables_purge_request", "ms", purgeRequest),
      recordedOnly("recorded"),
    );
    add(
      scalar("tables_purge_cleanup", "s", cleanupSeconds, {
        errors: cleaned && removed >= opts.rows ? 0 : 1,
        note: `${removed} rows removed from the purge to the end of the cleanup`,
      }),
      recordedOnly("every row removed"),
    );
    const purgeRead = (key: string, figure: string) => {
      const reading = duringPurge[key] as Reading;
      add(
        distribution(figure, "ms", reading.times, { errors: reading.errors }),
        upTo("p95 10 ms"),
      );
    };
    purgeRead("item", "tables_read_item_during_purge");
    purgeRead("row_page", "tables_read_row_page_during_purge");
    recorder.finish();
  } finally {
    clearInterval(sampler);
    await stopServer({ state: stateA }).catch((error: unknown) =>
      log(`stopping the first server: ${String(error)}`),
    );
    await stopServer({ state: stateB }).catch((error: unknown) =>
      log(`stopping the second server: ${String(error)}`),
    );
    if (opts.state === null) rmSync(work, { recursive: true, force: true });
    report();
  }
}
