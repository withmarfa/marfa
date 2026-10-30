/**
 * A device filling a large image library.
 *
 * A measurement, not a service level. It seeds two sets of rows of one shape,
 * one carrying a thumbnail in every row and one carrying none, hydrates a
 * working copy of each with the `marfa` binary, and writes what it saw to
 * `reports/load/hydration.json` beside the load reports. Nothing here asserts
 * a time. It fails only when a hydration fails or does not bring every row,
 * because a number taken from a fill that did not finish says nothing.
 *
 * The plain set runs first so that the rows of the heavier set are not on the
 * server while it is measured.
 *
 * The set size is `MARFA_HYDRATION_ROWS`, per set; the nightly run sets it
 * where the issue it answers asks for it, and a run with it unset is small
 * enough to try on a laptop.
 */

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { cpus, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { BulkActionJob, BulkItemInput } from "../../client/types.js";
import { generateJpeg } from "../../generators/blob-fixtures.js";
import { keychainEnv } from "../../utils/keychain.js";
import { cleanup, createTestContext } from "../../utils/setup.js";
import { percentile } from "../../utils/timing.js";
import { REPORTS_DIR } from "../load/results.js";

const run = promisify(execFile);

/** Rows in each set. */
const ROWS = positiveInteger("MARFA_HYDRATION_ROWS", 2_000);
/** Rows in a bulk write; a batch of the heavier set stays well under the bulk body cap. */
const BATCH = 250;
/** Rows sharing a tag, so a clean-up bulk action stays under the 50,000 a bulk action may match. */
const GROUP = 25_000;
/** The rows in a page of a hydration, `ITEM_PAGE_LIMIT` in `core/marfa-core/src/http.rs`. */
const PAGE = 200;
/** Pages read to measure the server, from the first. */
const SERVER_PAGES = 10;
/** Runs of each local read after its first. */
const READ_RUNS = 5;
/** The decoded size of a thumbnail, near the 11 KB of a real one at the size an app sends. */
const THUMBNAIL_BYTES = 11_400;
/** The longest a single command of the binary may take. */
const COMMAND_TIMEOUT_MS = 45 * 60_000;

const PLACES = [
  "harbor",
  "market",
  "station",
  "garden",
  "bridge",
  "museum",
  "beach",
  "castle",
  "tunnel",
  "square",
];
const CAMERAS = ["Leica Q3", "Fuji X100V", "Canon R5", "iPhone 17", "Sony A7"];
/** A word one row in ten holds, so a search has many matches to rank. */
const SEARCH_WORD = PLACES[0];

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive whole number, not ${raw}`);
  }
  return value;
}

function binary(): string {
  const path = process.env.MARFA_DEVICE_BIN;
  if (path === undefined || path === "") {
    throw new Error(
      "MARFA_DEVICE_BIN is required: the built `marfa` binary this measures. " +
        "Build it in release mode, since a debug build measures the build.",
    );
  }
  return path;
}

interface Spread {
  samples: number;
  median: number;
  min: number;
  max: number;
}

function spread(values: number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    median: percentile(sorted, 50),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

interface LocalRead {
  /** The first run after the fill, before anything has read the copy. */
  first_ms: number;
  /** The runs after it. */
  later_ms: Spread;
  results: number;
}

interface SetReport {
  rows: number;
  type: string;
  seed_ms: number;
  hydration_ms: number;
  rows_per_second: number;
  pages: number;
  /** Rows the fill reported holding; the run fails unless it is `rows`. */
  items: number;
  store_bytes: number;
  server_page: {
    rows_per_page: number;
    pages: number;
    /** The pages' `Content-Encoding`, `identity` where there is none. */
    encoding: string;
    /** Bytes of a page as they cross the wire. */
    bytes_per_page: number;
    bytes_per_row: number;
    ms: Spread;
  };
  /** `items list --limit 200`, answered from the copy. */
  listing: LocalRead;
  /** `search`, answered from the copy. */
  search: LocalRead;
}

interface Environment {
  url: string;
  key: string;
  store: string;
}

async function device(
  env: Environment,
  args: string[],
): Promise<{ stdout: string; ms: number }> {
  const start = performance.now();
  const { stdout } = await run(
    binary(),
    ["--json", "device", "--db", env.store, ...args],
    {
      env: {
        ...process.env,
        ...keychainEnv(),
        MARFA_API_URL: env.url,
        MARFA_API_KEY: env.key,
      },
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  return { stdout, ms: performance.now() - start };
}

async function localRead(env: Environment, args: string[]): Promise<LocalRead> {
  const times: number[] = [];
  let results = 0;
  for (let i = 0; i <= READ_RUNS; i++) {
    const { stdout, ms } = await device(env, args);
    const answer = JSON.parse(stdout) as {
      items?: unknown[];
      hits?: unknown[];
      completeness: string;
    };
    expect(answer.completeness, "a read of the whole copy").toBe("complete");
    results = (answer.items ?? answer.hits ?? []).length;
    times.push(ms);
  }
  return {
    first_ms: times[0],
    later_ms: spread(times.slice(1)),
    results,
  };
}

/** The size of the copy: its database file and the write-ahead log beside it. */
function storeBytes(store: string): number {
  return [store, `${store}-wal`]
    .filter((file) => existsSync(file))
    .reduce((sum, file) => sum + statSync(file).size, 0);
}

interface PageRead {
  ms: number;
  wireBytes: number;
  encoding: string;
  body: { data: unknown[]; next_cursor: string | null };
}

/**
 * One page as the device asks for it (`items_page` in `core/marfa-core/src/http.rs`),
 * sent with `Accept-Encoding: gzip` as the binary sends it. The time is to the
 * last byte; unpacking and parsing the body are after it.
 */
function readPage(
  url: string,
  key: string,
  type: string,
  cursor: string | null,
): Promise<PageRead> {
  const query = new URLSearchParams({
    type,
    tier: "library",
    state: "any",
    include: "edges,metadata",
    limit: String(PAGE),
  });
  if (cursor !== null) query.set("cursor", cursor);
  const target = new URL(`/items?${query.toString()}`, url);
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const req = request(
      target,
      {
        headers: { authorization: `Bearer ${key}`, "accept-encoding": "gzip" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const ms = performance.now() - start;
          const wire = Buffer.concat(chunks);
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `a page answered ${String(res.statusCode)}: ${wire.toString("utf8").slice(0, 300)}`,
              ),
            );
            return;
          }
          const encoding = res.headers["content-encoding"] ?? "identity";
          const text = (encoding === "gzip" ? gunzipSync(wire) : wire).toString(
            "utf8",
          );
          resolve({
            ms,
            wireBytes: wire.length,
            encoding,
            body: JSON.parse(text) as PageRead["body"],
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Pages from the first, following the cursors as a fill does. */
async function serverPages(
  url: string,
  key: string,
  type: string,
): Promise<SetReport["server_page"]> {
  const times: number[] = [];
  let bytes = 0;
  let rows = 0;
  let encoding = "identity";
  let cursor: string | null = null;
  for (let i = 0; i < SERVER_PAGES; i++) {
    const page = await readPage(url, key, type, cursor);
    times.push(page.ms);
    bytes += page.wireBytes;
    rows += page.body.data.length;
    encoding = page.encoding;
    cursor = page.body.next_cursor;
    if (cursor === null) break;
  }
  return {
    rows_per_page: Math.round(rows / times.length),
    pages: times.length,
    encoding,
    bytes_per_page: Math.round(bytes / times.length),
    bytes_per_row: Math.round(bytes / rows),
    ms: spread(times),
  };
}

function row(type: string, i: number, withThumbnail: boolean): BulkItemInput {
  const properties: Record<string, unknown> = {
    title: `IMG_${String(i).padStart(6, "0")}.jpg`,
    caption: `Frame ${String(i)} at the ${PLACES[i % PLACES.length]}`,
    camera: CAMERAS[i % CAMERAS.length],
    seq: i,
  };
  if (withThumbnail) {
    // Different bytes in every row, so a transfer that squeezes repeated
    // content cannot make a fill look cheaper than a library of different
    // photographs would. The server reads only the format's signature and the
    // size, so this stands in for a JPEG at its size.
    const jpeg = generateJpeg(160, 120, THUMBNAIL_BYTES, i + 1);
    properties.thumbnail = `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`;
  }
  return {
    type,
    source_id: `${type}-${String(i)}`,
    tier: "library",
    tags: [groupTag(i)],
    properties,
  };
}

function groupTag(i: number): string {
  return `bench-group-${String(Math.floor(i / GROUP))}`;
}

async function seed(
  client: MarfaClient,
  type: string,
  withThumbnail: boolean,
): Promise<number> {
  const start = performance.now();
  for (let from = 0; from < ROWS; from += BATCH) {
    const items = Array.from({ length: Math.min(BATCH, ROWS - from) }, (_, k) =>
      row(type, from + k, withThumbnail),
    );
    const written = await client.bulkItems({
      items,
      mode: "create_only",
      atomic: false,
    });
    if (!written.ok || written.data.counts.created !== items.length) {
      throw new Error(
        `seeding ${type} from row ${String(from)} wrote ${String(written.data?.counts.created)} of ${String(items.length)}: ${JSON.stringify(written.error ?? written.data?.results.find((r) => r.outcome === "errored"))}`,
      );
    }
    if ((from / BATCH) % 40 === 0) {
      console.log(
        `  seeded ${String(from + items.length)} of ${String(ROWS)} ${type} in ${((performance.now() - start) / 1000).toFixed(0)}s`,
      );
    }
  }
  return performance.now() - start;
}

/**
 * Takes the set's rows off the server, a bulk action at a time, so a server
 * that outlives the run is not left holding a library. A bulk action refuses to
 * match more than 50,000 rows, so each goes at one tagged group of the set.
 */
async function removeRows(client: MarfaClient, type: string): Promise<void> {
  const step = async (
    input: Parameters<MarfaClient["bulkAction"]>[0],
  ): Promise<void> => {
    const started = await client.bulkAction(input);
    if (started.status !== 202) {
      throw new Error(
        `a bulk action answered ${String(started.status)}: ${JSON.stringify(started.error)}`,
      );
    }
    const job = await client.pollBulkActionToTerminal(
      (started.data as BulkActionJob).id,
      { intervalMs: 500, timeoutMs: 30 * 60_000 },
    );
    if (job.status !== "completed") {
      throw new Error(`a bulk action ended ${job.status}: ${job.error ?? ""}`);
    }
  };
  for (let from = 0; from < ROWS; from += GROUP) {
    const tags = [groupTag(from)];
    await step({
      action: "transition",
      state: "trashed",
      filter: { type, tags, state: "active" },
      max_items: GROUP,
    });
    await step({
      action: "purge",
      confirm: "PURGE",
      filter: { type, tags, state: "trashed" },
      max_items: GROUP,
    });
  }
}

async function writeReport(sets: Record<string, SetReport>): Promise<void> {
  const { stdout } = await run(binary(), ["--version"]);
  await mkdir(REPORTS_DIR, { recursive: true });
  await writeFile(
    join(REPORTS_DIR, "hydration.json"),
    JSON.stringify(
      {
        scenario: "hydration.image-library",
        timestamp: new Date().toISOString(),
        rows_per_set: ROWS,
        page_rows: PAGE,
        thumbnail_bytes: THUMBNAIL_BYTES,
        binary: stdout.trim(),
        machine: { platform: platform(), cpus: cpus().length },
        sets,
      },
      null,
      2,
    ),
  );
}

describe("a device filling a library of images", () => {
  let ctx: Awaited<ReturnType<typeof createTestContext>>["ctx"];
  let client: MarfaClient;
  let url: string;
  let key: string;
  const types: string[] = [];
  const sets: Record<string, SetReport> = {};
  let work: string;

  beforeAll(async () => {
    binary();
    ({
      ctx,
      client,
      apiUrl: url,
      apiKey: key,
    } = await createTestContext("hydration", "image-library"));
    work = mkdtempSync(join(realpathSync(tmpdir()), "marfa-hydration-"));
  });

  async function measure(
    name: string,
    withThumbnail: boolean,
  ): Promise<SetReport> {
    const type = `user.bench-${name}-${ctx.runId}`;
    const registered = await client.registerType({
      id: type,
      fields: {
        title: { type: "string", required: true },
        caption: { type: "string" },
        camera: { type: "string" },
        seq: { type: "integer" },
        ...(withThumbnail ? { thumbnail: { type: "thumbnail" } } : {}),
      },
    });
    expect(registered.ok, JSON.stringify(registered.error)).toBe(true);
    types.push(type);

    const seed_ms = await seed(client, type, withThumbnail);
    console.log(
      `  seeded ${String(ROWS)} ${name} rows in ${(seed_ms / 1000).toFixed(0)}s`,
    );

    const env: Environment = { url, key, store: join(work, `${name}.sqlite`) };
    const filled = await device(env, [
      "hydrate",
      "--types",
      type,
      "--tier",
      "library",
    ]);
    const hydrated = JSON.parse(filled.stdout) as {
      items: number;
      pages: number;
    };
    expect(hydrated.items, "rows the fill brought").toBe(ROWS);

    const report: SetReport = {
      rows: ROWS,
      type,
      seed_ms,
      hydration_ms: filled.ms,
      rows_per_second: ROWS / (filled.ms / 1000),
      pages: hydrated.pages,
      items: hydrated.items,
      store_bytes: storeBytes(env.store),
      server_page: await serverPages(url, key, type),
      listing: await localRead(env, [
        "items",
        "list",
        "--type",
        type,
        "--limit",
        String(PAGE),
      ]),
      search: await localRead(env, ["search", SEARCH_WORD, "--type", type]),
    };
    expect(report.listing.results, "rows the copy lists").toBe(
      Math.min(PAGE, ROWS),
    );
    expect(report.search.results, "hits the copy finds").toBeGreaterThan(0);
    console.log(
      `  ${name}: filled ${String(ROWS)} rows in ${(report.hydration_ms / 1000).toFixed(1)}s ` +
        `(${report.rows_per_second.toFixed(0)} rows/s), ${String(report.server_page.bytes_per_row)} bytes a row, ` +
        `store ${(report.store_bytes / 1e6).toFixed(0)} MB`,
    );
    rmSync(env.store, { force: true });
    rmSync(`${env.store}-wal`, { force: true });
    rmSync(`${env.store}-shm`, { force: true });
    return report;
  }

  it("fills a copy of rows with no thumbnail, then of rows with one", async () => {
    sets.plain = await measure("plain", false);
    sets.thumbnails = await measure("thumbnails", true);
  });

  // The report goes first, so a slow or failed clean-up cannot lose it.
  afterAll(async () => {
    try {
      if (Object.keys(sets).length > 0) await writeReport(sets);
    } finally {
      if (work !== undefined) rmSync(work, { recursive: true, force: true });
      try {
        for (const type of types) await removeRows(client, type);
      } catch (error) {
        console.error("removing the rows failed:", error);
        throw error;
      } finally {
        await cleanup(ctx);
      }
    }
  });
});
