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
import { timedAnswer } from "../../src/utils/scale/answer.js";
import { readServerMemory } from "../../src/utils/scale/memory.js";
import { StartedServers } from "../../src/utils/scale/servers.js";
import {
  expectedTotals,
  judgeRows,
  judgeTotals,
  rowOf,
  type Expected,
} from "../../src/utils/scale/table-data.js";
import { BatchLedger } from "../../src/utils/scale/table-stream.js";
import {
  WalkChecker,
  type Ending,
  type Ordering,
} from "../../src/utils/scale/table-walk.js";
import { Tasks } from "../../src/utils/scale/tasks.js";
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
const POLL_GAP_MS = 20;
const ORDER_BUDGET_MS = 30_000;
const TOTAL_RUNS = 30;
const READER_KEYS = 7;
const STALL_MS = 500;
const UNDO_REPEATS = 5;
const PURGE_NUDGE_MS = 60_000;
const PURGE_LIMIT_MS = 600_000;
const WRITE_FLOOR = 20_000;
const FRAME_WAIT_MS = 10_000;

// A refusal is counted, never retried, so it cannot pass as a slow answer.
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
  return timedAnswer(() =>
    fetch(`${connection.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${connection.key}`,
        ...(payload === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body: payload,
      signal: AbortSignal.timeout(900_000),
    }),
  );
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

function followStream(connection: Connection, ledger: BatchLedger) {
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
                  ledger.frame(event.data, at);
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
    stop: async () => {
      await ready;
      await close();
      await ended;
    },
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
  /** Pages refused, plus every way the traversal was wrong. */
  errors: number;
  ending: Ending;
  /** The first row of each page, to name a range of the table. */
  firsts: string[];
  /** The rows of the first page. */
  firstRows: { id: string; values: Record<string, unknown> }[];
  /** Per page, how many rows it held and the cents they read in all. */
  pageSums: { rows: number; cents: number }[];
  digest: string;
}

interface WalkSpec {
  order: Ordering;
  /** What the generated rows `0..rows-1` hold, and the rows a filter keeps. */
  rows: number;
  buckets: number;
  keep?: (n: number) => boolean;
  query: string;
  budgetMs?: number;
}

const WALK_LIMIT = 1000;

async function walk(
  connection: Connection,
  itemId: string,
  spec: WalkSpec,
): Promise<Walk> {
  const base = `/items/${itemId}/tables/${TABLE}/rows?limit=${WALK_LIMIT}&${spec.query}`;
  const pages = Math.ceil(spec.rows / WALK_LIMIT);
  const checker = new WalkChecker({
    limit: WALK_LIMIT,
    rows: spec.rows,
    buckets: spec.buckets,
    order: spec.order,
    ...(spec.keep === undefined ? {} : { keep: spec.keep }),
  });
  await send("GET", base, undefined, connection);
  const result: Walk = {
    times: [],
    errors: 0,
    ending: "pages",
    firsts: [],
    firstRows: [],
    pageSums: [],
    digest: "",
  };
  let cursor: string | null = null;
  const started = performance.now();
  for (let page = 0; page < pages; page++) {
    if (performance.now() - started > (spec.budgetMs ?? Infinity)) {
      result.ending = "budget";
      break;
    }
    const answer = await send(
      "GET",
      cursor === null ? base : `${base}&cursor=${encodeURIComponent(cursor)}`,
      undefined,
      connection,
    );
    if (!ok(answer)) {
      result.errors++;
      result.ending = "failed";
      log(
        `page ${page} of ${spec.query}: ${answer.status} ${answer.text.slice(0, 160)}`,
      );
      break;
    }
    result.times.push(answer.ms);
    let body: { data?: { id: string; values: Record<string, unknown> }[] };
    try {
      body = answer.json() as typeof body;
    } catch {
      body = {};
    }
    checker.page(body, cursor);
    const first = body.data?.[0];
    if (first !== undefined) result.firsts.push(first.id);
    if (page === 0) result.firstRows = body.data ?? [];
    cursor = (body as { next_cursor?: string | null }).next_cursor ?? null;
    if (cursor === null) {
      result.ending = "end";
      break;
    }
  }
  checker.finish(result.ending);
  result.errors += checker.problemCount;
  result.pageSums = checker.pageSums;
  result.digest = checker.digest();
  for (const problem of checker.problems)
    log(`${spec.query || "by id"}: ${problem}`);
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
  const started = new StartedServers();
  const tasks = new Tasks();
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
    started.starting(stateA);
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
            order: "reading",
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
    const ledger = new BatchLedger(itemId, TABLE, buckets);
    const stream = followStream(reader(), ledger);
    const stopStream = tasks.own(() => stream.stop());
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
    const stopReaders = tasks.own(readers.stop);
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
      if (judged.batch !== null) {
        ledger.written(judged.batch, judged.written, performance.now());
      }
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
    const during = await stopReaders();
    const framesBy = performance.now() + FRAME_WAIT_MS;
    while (ledger.waiting > 0 && performance.now() < framesBy) await sleep(50);
    await stopStream();
    ledger.finish();
    for (const problem of ledger.problems) log(`stream: ${problem}`);

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
    add(
      distribution("tables_stream_lag_during_write", "ms", ledger.lags, {
        errors: ledger.problemCount,
        note: `${ledger.batches} of ${pages} batches matched their frame; lag is from the write's answer to the frame, 0 when the frame came first`,
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

    const walkPages = Math.ceil(opts.rows / WALK_LIMIT);
    const byId = await walk(connection, itemId, {
      order: "id",
      rows: opts.rows,
      buckets,
      query: "",
    });
    add(
      distribution("tables_page_by_id", "ms", byId.times, {
        errors: byId.errors,
        note: `${byId.times.length} of ${walkPages} pages, the whole table by cursor`,
      }),
      upTo("p95 20 ms"),
    );
    const byUpdated = await walk(connection, itemId, {
      order: "updated_at",
      rows: opts.rows,
      buckets,
      query: "sort=updated_at",
      budgetMs: ORDER_BUDGET_MS,
    });
    add(
      distribution("tables_page_by_updated_at", "ms", byUpdated.times, {
        errors: byUpdated.errors,
        note: `${byUpdated.times.length} pages by cursor from the start, sorted by updated_at`,
      }),
      upTo("p95 20 ms"),
    );
    const byOrder = await walk(connection, itemId, {
      order: "reading",
      rows: opts.rows,
      buckets,
      query: "sort=values.reading",
      budgetMs: ORDER_BUDGET_MS,
    });
    add(
      distribution("tables_page_by_order", "ms", byOrder.times, {
        errors: byOrder.errors,
        note: `${byOrder.times.length} pages by cursor from the start, sorted by the table's order column`,
      }),
      upTo("p95 20 ms"),
    );
    const byColumn = await walk(connection, itemId, {
      order: "bucket",
      rows: opts.rows,
      buckets,
      query: "sort=values.bucket",
      budgetMs: ORDER_BUDGET_MS,
    });
    add(
      distribution("tables_page_by_column", "ms", byColumn.times, {
        errors: byColumn.errors,
        note: `${byColumn.times.length} pages by cursor from the start, sorted by another column`,
      }),
      recordedOnly(
        "a known limit: a column other than the order reads the whole table",
      ),
    );
    const picked = 3 % buckets;
    const filtered = await walk(connection, itemId, {
      order: "id",
      rows: opts.rows,
      buckets,
      keep: (n) => n % buckets === picked,
      query: `filter=${encodeURIComponent(`values.bucket eq ${picked}`)}`,
      budgetMs: ORDER_BUDGET_MS,
    });
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
      expected: (run: number) => Expected,
    ) => {
      const times: number[] = [];
      let errors = 0;
      let selected = 0;
      for (let run = -3; run < runs; run++) {
        const at = Math.abs(run);
        const query = filter(at);
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
        const wrong = judgeTotals(answer.json(), expected(at));
        if (wrong !== null) {
          errors++;
          log(`totals of ${query || "every row"}: ${wrong}`);
          continue;
        }
        if (run >= 0) {
          times.push(answer.ms);
          selected = expected(at).rows;
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
    const small = await totals(
      hundredPath,
      () => "",
      TOTAL_RUNS,
      () => expectedTotals(100_000),
    );
    add(
      distribution("tables_total_100k", "ms", small.times, {
        errors: small.errors,
        note: `each total over a table of ${small.selected} rows`,
      }),
      upTo("p95 50 ms"),
    );
    const bucketTotals = new Map<number, Expected>();
    const ofBucket = (bucket: number) => {
      let held = bucketTotals.get(bucket);
      if (held === undefined) {
        held = expectedTotals(opts.rows, (n) => n % buckets === bucket);
        bucketTotals.set(bucket, held);
      }
      return held;
    };
    const byBucket = await totals(
      tablePath,
      (run) => `values.bucket eq ${run % buckets}`,
      TOTAL_RUNS,
      (run) => ofBucket(run % buckets),
    );
    add(
      distribution("tables_total_100k_by_column", "ms", byBucket.times, {
        errors: byBucket.errors,
        note: `each total over the rows of one bucket (${byBucket.selected} in the last), picked by a column of a ${opts.rows}-row table`,
      }),
      recordedOnly("recorded"),
    );
    const from = byId.firsts[100];
    const to = byId.firsts[200];
    if (from !== undefined && to !== undefined && byId.ending === "end") {
      const range = byId.pageSums.slice(100, 200).reduce(
        (sum, page) => ({
          rows: sum.rows + page.rows,
          cents: sum.cents + page.cents,
        }),
        { rows: 0, cents: 0 },
      );
      const byRange = await totals(
        tablePath,
        () => `id gte "${from}" AND id lt "${to}"`,
        TOTAL_RUNS,
        () => range,
      );
      add(
        distribution("tables_total_100k_by_id", "ms", byRange.times, {
          errors: byRange.errors,
          note: `each total over ${byRange.selected} rows picked by a range of ids of a ${opts.rows}-row table`,
        }),
        recordedOnly("recorded"),
      );
    }
    const whole = expectedTotals(opts.rows);
    const everything = await totals(
      tablePath,
      () => "",
      5,
      () => whole,
    );
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
    const insertTally = { errors: 0 };
    const undoPatchTally = { errors: 0 };
    const patchTally = { errors: 0 };
    const undo = async (
      batch: string,
      into: number[],
      tally: { errors: number },
    ) => {
      const answer = await send(
        "POST",
        `${tablePath}/batches/${batch}/undo`,
        undefined,
        connection,
      );
      if (!ok(answer)) {
        tally.errors++;
        log(`undo of ${batch}: ${answer.status} ${answer.text.slice(0, 160)}`);
        return null;
      }
      into.push(answer.ms);
      return (answer.json() as { batch: string | null }).batch;
    };
    const rowCount = async () => {
      const listed = await send(
        "GET",
        `/items/${itemId}/tables`,
        undefined,
        connection,
      );
      await mustOk("listing the tables", listed);
      return (
        listed.json() as { data: { name: string; row_count: number }[] }
      ).data.find((t) => t.name === TABLE)?.row_count;
    };
    const batchRows = Math.min(1000, opts.rows);
    const originals = byId.firstRows.slice(0, batchRows);
    const originalIds = originals.map((row) => row.id);
    const originalValues = originals.map((row) => row.values);
    const firstRows = async () => {
      const page = await send(
        "GET",
        `${tablePath}/rows?limit=${originalIds.length}`,
        undefined,
        connection,
      );
      if (!ok(page)) return undefined;
      return (page.json() as { data?: unknown }).data;
    };
    const holds = async (
      tally: { errors: number },
      what: string,
      values: Record<string, unknown>[],
    ) => {
      const wrong = judgeRows(await firstRows(), originalIds, values);
      if (wrong !== null) {
        tally.errors++;
        log(`${what}: ${wrong}`);
      }
    };
    const countIs = async (
      tally: { errors: number },
      what: string,
      wanted: number,
    ) => {
      const held = await rowCount();
      if (held !== wanted) {
        tally.errors++;
        log(`${what}: the table holds ${String(held)} rows, not ${wanted}`);
      }
    };
    if (originals.length !== batchRows) {
      throw new Error(
        `the first page holds ${originals.length} rows, not ${batchRows}`,
      );
    }
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
      if (inserted.batch === null || inserted.errors > 0) {
        insertTally.errors++;
        continue;
      }
      await countIs(insertTally, "after the insert", opts.rows + batchRows);
      const undone = await undo(inserted.batch, undoInsert, insertTally);
      if (undone !== null) {
        await countIs(insertTally, "after the undo", opts.rows);
        const redone = await undo(undone, undoInsert, insertTally);
        if (redone !== null) {
          await countIs(insertTally, "after the redo", opts.rows + batchRows);
          await undo(redone, undoInsert, insertTally);
        }
      }
      await countIs(insertTally, "after the last undo", opts.rows);
      const patch = await send(
        "POST",
        `${tablePath}/rows`,
        JSON.stringify({
          operations: originalIds.map((id) => ({
            op: "patch",
            id,
            values: { note: `patched ${repeat}` },
          })),
        }),
        connection,
      );
      if (!ok(patch)) {
        patchTally.errors++;
        log(`patch: ${patch.status} ${patch.text.slice(0, 160)}`);
        continue;
      }
      patchTimes.push(patch.ms);
      const patchBatch = (patch.json() as { batch: string | null }).batch;
      if (patchBatch === null) {
        patchTally.errors++;
        log("patch: the answer names no batch");
        continue;
      }
      await holds(
        patchTally,
        "after the patch",
        originalValues.map((values) => ({
          ...values,
          note: `patched ${repeat}`,
        })),
      );
      if ((await undo(patchBatch, undoPatch, undoPatchTally)) !== null) {
        await holds(
          undoPatchTally,
          "after the undo of the patch",
          originalValues,
        );
      }
    }
    add(
      distribution("tables_undo_insert_batch", "ms", undoInsert, {
        errors: insertTally.errors,
        note: `${batchRows} rows; the undo of an insert, of its undo, and of that`,
      }),
      recordedOnly("recorded"),
    );
    add(
      distribution("tables_undo_patch_batch", "ms", undoPatch, {
        errors: undoPatchTally.errors,
        note: `${batchRows} rows patched, then undone`,
      }),
      recordedOnly("recorded"),
    );
    add(
      distribution("tables_patch_batch", "ms", patchTimes, {
        errors: patchTally.errors,
        note: `${batchRows} rows patched`,
      }),
      recordedOnly("recorded"),
    );
    const afterCount = await rowCount();
    if (afterCount !== opts.rows) {
      throw new Error(
        `after the undos the table holds ${String(afterCount)} rows, not ${opts.rows}`,
      );
    }
    const totalsAnswer = await send(
      "GET",
      `${tablePath}/totals`,
      undefined,
      connection,
    );
    await mustOk("totalling the table after the undos", totalsAnswer);
    const wrongTotals = judgeTotals(totalsAnswer.json(), whole);
    if (wrongTotals !== null) {
      throw new Error(`after the undos the totals are wrong: ${wrongTotals}`);
    }

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

    started.starting(stateB);
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
    await mustOk("listing the restored tables", restoredTables);
    const restoredCount = (
      restoredTables.json() as { data: { name: string; row_count: number }[] }
    ).data.find((t) => t.name === TABLE)?.row_count;
    const restoredTotals = await send(
      "GET",
      `/items/${itemId}/tables/${TABLE}/totals`,
      undefined,
      restoreInto,
    );
    await mustOk("totalling the restored table", restoredTotals);
    const restoredProblems: string[] = [];
    if (restoredCount !== opts.rows) {
      restoredProblems.push(
        `the table holds ${String(restoredCount)} rows, not ${opts.rows}`,
      );
    }
    const wrongRestored = judgeTotals(restoredTotals.json(), whole);
    if (wrongRestored !== null) restoredProblems.push(wrongRestored);
    const restoredWalk = await walk(restoreInto, itemId, {
      order: "id",
      rows: opts.rows,
      buckets,
      query: "",
    });
    if (restoredWalk.errors > 0) {
      restoredProblems.push(
        `${restoredWalk.errors} faults reading the restored rows back`,
      );
    }
    if (restoredWalk.digest !== byId.digest) {
      restoredProblems.push("the restored row ids differ from the source's");
    }
    for (const problem of restoredProblems) log(`restore: ${problem}`);
    add(
      scalar("tables_rows_restored", "count", restoredCount ?? 0, {
        errors: restoredProblems.length,
        note:
          restoredProblems.length === 0
            ? "every row read back, with the values written and the totals computed from them"
            : restoredProblems.join("; "),
      }),
      recordedOnly("every row, with its values, and the same totals"),
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
    const stopPurgeReaders = tasks.own(purgeReaders.stop);
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
    const duringPurge = await stopPurgeReaders();
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
    for (const failure of await tasks.stopAll()) {
      log(`stopping a reader or the stream: ${failure}`);
    }
    for (const failure of await started.stopAll((state) =>
      stopServer({ state }),
    )) {
      log(`stopping a server: ${failure}`);
    }
    if (opts.state === null) rmSync(work, { recursive: true, force: true });
    report();
  }
}
