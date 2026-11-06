/**
 * Writing: the N-item load through `POST /items/bulk` with a reader polling
 * beside it, then a smaller count through single `POST /items`.
 */
import type { BulkResponse } from "../../src/client/types.js";
import { scaleItem } from "../../src/utils/scale/generator.js";
import { idOf, type Context } from "./context.js";
import { distribution, log, scalar, unavailable } from "./figures.js";
import {
  connect,
  missingDoor,
  ok,
  parse,
  request,
  sleep,
  type Target,
} from "./http.js";
import { readProcesses, Sampler } from "./processes.js";

/** What the scale kit's seed and the core's drain send. */
const PAGE = 1_000;
const GIVE_UP_AFTER_REFUSED_PAGES = 3;
/** Between two reads of the reader, so it is a person and not a flood. */
const READ_GAP_MS = 10;

interface Reader {
  stop: () => Promise<{ times: number[]; errors: number }>;
}

/** Reads an item already written, again and again, until stopped. */
function startReader(target: Target, ids: string[]): Reader {
  let running = true;
  const times: number[] = [];
  let errors = 0;
  const loop = (async () => {
    for (let i = 0; running; i++) {
      if (ids.length === 0) {
        await sleep(20);
        continue;
      }
      const id = ids[(i * 7_919) % ids.length] as string;
      const reply = await request(target, "GET", `/items/${id}`);
      if (ok(reply)) times.push(reply.ms);
      else errors++;
      await sleep(READ_GAP_MS);
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      return { times, errors };
    },
  };
}

export async function bulkLoad(ctx: Context): Promise<void> {
  const target = connect(ctx.state);
  const { record } = ctx;
  const ids: string[] = [];
  const pageTimes: number[] = [];
  let written = 0;
  let updated = 0;
  let errors = 0;
  let refusedInARow = 0;

  const cpuBefore = (await readProcesses(ctx.state)).serverCpuS;
  const sampler = new Sampler(ctx.state);
  sampler.start();
  const reader = startReader(target, ids);
  const started = performance.now();

  for (let from = 1; from <= ctx.items; from += PAGE) {
    const to = Math.min(ctx.items, from + PAGE - 1);
    const items = [];
    for (let n = from; n <= to; n++) items.push(scaleItem(n));
    const body = JSON.stringify({ items, mode: "upsert", atomic: false });
    const reply = await request(target, "POST", "/items/bulk", body);
    if (from === 1 && missingDoor(reply)) {
      sampler.stop();
      await reader.stop();
      const why = `POST /items/bulk answered ${reply.status}`;
      for (const name of [
        "bulk_rows_per_s",
        "bulk_page_ms",
        "read_during_bulk_ms",
      ]) {
        record.add(unavailable({ name, label: name, unit: "ms" }, why));
      }
      record.note(`${why}; the load is written through single POST /items`);
      await loadOneByOne(ctx, target);
      return;
    }
    if (!ok(reply)) {
      errors += items.length;
      refusedInARow++;
      log(
        `items ${from}-${to} refused with ${reply.status}: ${reply.text.slice(0, 300)}`,
      );
      if (refusedInARow >= GIVE_UP_AFTER_REFUSED_PAGES) break;
      continue;
    }
    refusedInARow = 0;
    pageTimes.push(reply.ms);
    const answer = parse<BulkResponse>(reply);
    for (const entry of answer?.results ?? []) {
      if (
        entry.id !== undefined &&
        (entry.outcome === "created" || entry.outcome === "updated")
      ) {
        ids.push(entry.id);
      }
    }
    written += answer?.counts.created ?? 0;
    updated += answer?.counts.updated ?? 0;
    errors += answer?.counts.errored ?? 0;
    if (((from - 1) / PAGE) % 10 === 0) {
      log(`${(from - 1 + items.length).toLocaleString("en-US")} items sent`);
    }
  }

  const wallS = (performance.now() - started) / 1000;
  const read = await reader.stop();
  sampler.stop();
  const cpuAfter = (await readProcesses(ctx.state)).serverCpuS;
  ctx.ids = ids;

  const requestS = pageTimes.reduce((sum, ms) => sum + ms, 0) / 1000;
  record.add(
    scalar(
      {
        name: "bulk_items_written",
        label: "Items the bulk load wrote",
        unit: "count",
        better: "neither",
        errors,
        note:
          updated > 0
            ? `${updated} of them updated an item already there`
            : undefined,
      },
      written + updated,
    ),
  );
  record.add(
    scalar(
      {
        name: "bulk_rows_per_s",
        label: `Bulk load, items a second (pages of ${PAGE})`,
        unit: "per_s",
        better: "higher",
        errors,
        note: "items written over the time the pages' requests took",
      },
      (written + updated) / requestS,
    ),
  );
  record.add(
    scalar(
      {
        name: "bulk_wall_s",
        label: `Bulk load of ${ctx.items.toLocaleString("en-US")} items, wall time`,
        unit: "s",
        note: "includes building each page's body in the harness",
      },
      wallS,
    ),
  );
  record.add(
    distribution(
      {
        name: "bulk_page_ms",
        label: `One bulk page of ${PAGE}`,
        unit: "ms",
      },
      pageTimes,
    ),
  );
  record.add(
    distribution(
      {
        name: "read_during_bulk_ms",
        label: "GET /items/{id} while bulk pages are written",
        unit: "ms",
        errors: read.errors,
      },
      read.times,
    ),
  );
  record.add(
    scalar(
      {
        name: "bulk_server_cpu_s",
        label: "Server CPU used by the bulk load",
        unit: "s",
        note: "user and system time of the server processes, from ps",
      },
      cpuAfter - cpuBefore,
    ),
  );
  record.add(
    scalar(
      {
        name: "rss_peak_during_bulk_mb",
        label: "Server memory, peak during the bulk load",
        unit: "MB",
        note: `the highest of ${sampler.samples} ps readings 250 ms apart; with the adapter's supervisor, ${sampler.peakTreeMb.toFixed(1)} MB`,
      },
      sampler.peakServerMb,
    ),
  );
}

/** The load when the server has no bulk door. */
async function loadOneByOne(ctx: Context, target: Target): Promise<void> {
  const started = performance.now();
  let errors = 0;
  for (let n = 1; n <= ctx.items; n++) {
    const reply = await request(target, "POST", "/items", scaleItem(n));
    const id = ok(reply) ? idOf(parse(reply)) : undefined;
    if (id === undefined) errors++;
    else ctx.ids.push(id);
  }
  ctx.record.add(
    scalar(
      {
        name: "bulk_items_written",
        label: "Items the load wrote (one POST /items each)",
        unit: "count",
        better: "neither",
        errors,
      },
      ctx.ids.length,
    ),
  );
  ctx.record.add(
    scalar(
      {
        name: "bulk_wall_s",
        label: `Load of ${ctx.items.toLocaleString("en-US")} items one at a time, wall time`,
        unit: "s",
      },
      (performance.now() - started) / 1000,
    ),
  );
}

/** Single creates, after the load, at positions past it. */
export async function singleCreates(ctx: Context): Promise<void> {
  const target = connect(ctx.state);
  const times: number[] = [];
  let errors = 0;
  const first = ctx.items + 1;
  for (let i = 0; i < ctx.singles; i++) {
    const reply = await request(target, "POST", "/items", scaleItem(first + i));
    if (i === 0 && missingDoor(reply)) {
      ctx.record.add(
        unavailable(
          { name: "create_one_ms", label: "POST /items", unit: "ms" },
          `POST /items answered ${reply.status}`,
        ),
      );
      return;
    }
    const id = ok(reply) ? idOf(parse(reply)) : undefined;
    if (id === undefined) {
      errors++;
      if (errors === 1)
        log(`POST /items: ${reply.status} ${reply.text.slice(0, 200)}`);
      continue;
    }
    times.push(reply.ms);
    ctx.singleIds.push(id);
  }
  ctx.record.add(
    distribution(
      {
        name: "create_one_ms",
        label: "POST /items, one item",
        unit: "ms",
        errors,
      },
      times,
    ),
  );
  const seconds = times.reduce((sum, ms) => sum + ms, 0) / 1000;
  ctx.record.add(
    scalar(
      {
        name: "create_one_rows_per_s",
        label: `Single creates, items a second (${ctx.singles} in a row)`,
        unit: "per_s",
        better: "higher",
        errors,
      },
      times.length / seconds,
    ),
  );
}
