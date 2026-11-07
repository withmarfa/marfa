/**
 * A benchmark that drives any Marfa server the conformance adapter booted,
 * knowing only its state directory, so that two implementations can be
 * measured on the same machine and the same workload, back to back.
 *
 *   tsx scripts/slice-bench/run.ts run --state <dir> --items <n> --out <file>
 *     [--label <name>] [--repeats <n>] [--singles <n>] [--starts <n>]
 *     [--settle-ms <ms>] [--rest-ms <ms>] [--skip <step,...>]
 *     [--program <label>=<path> ...]
 *   tsx scripts/slice-bench/run.ts compare <first.json> <second.json>
 *
 * `run` expects a fresh instance booted with `pnpm marfa:up --state <dir>`
 * and leaves it running, holding the items it wrote. The steps, in order,
 * each skippable by name: `memory`, `bulk`, `singles`, `items`, `lists`,
 * `search`, `warm`, `cold`. Without `bulk` the later steps have no items to
 * work on. `cold` boots fresh instances in `<dir>.cold-<i>` and removes them.
 * `compare` prints a Markdown table of two runs' files with the ratio.
 */
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { compare } from "./compare.js";
import type { Context } from "./context.js";
import { log, newRun, Recorder } from "./figures.js";
import { connect, request } from "./http.js";
import { lists, search, singleItems } from "./reads.js";
import { coldStarts, warmStarts } from "./starts.js";
import { databaseSize, programSizes, restingMemory } from "./storage.js";
import { bulkLoad, singleCreates } from "./writes.js";

const STEPS = [
  "memory",
  "bulk",
  "singles",
  "items",
  "lists",
  "search",
  "warm",
  "cold",
];

function whole(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`--${name} needs a whole number, not ${raw}`);
  }
  return value;
}

async function measure(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      state: { type: "string" },
      items: { type: "string" },
      out: { type: "string" },
      label: { type: "string" },
      repeats: { type: "string" },
      singles: { type: "string" },
      starts: { type: "string" },
      "settle-ms": { type: "string" },
      "rest-ms": { type: "string" },
      skip: { type: "string" },
      program: { type: "string", multiple: true },
    },
  });
  if (
    values.state === undefined ||
    values.items === undefined ||
    values.out === undefined
  ) {
    throw new Error("run needs --state <dir>, --items <n> and --out <file>");
  }
  const items = whole(values.items, 0, "items");
  if (items < 1_000) throw new Error("--items needs at least 1,000");
  const skip = new Set(
    (values.skip ?? "").split(",").filter((step) => step !== ""),
  );
  for (const step of skip) {
    if (!STEPS.includes(step))
      throw new Error(`--skip names no step called ${step}`);
  }
  const out = resolve(values.out);
  const record = new Recorder(
    newRun(values.label ?? basename(out, ".json"), items),
    out,
  );
  const ctx: Context = {
    state: resolve(values.state),
    items,
    repeats: Math.max(1, whole(values.repeats, 100, "repeats")),
    singles: whole(
      values.singles,
      Math.min(1_000, Math.floor(items / 10)),
      "singles",
    ),
    starts: whole(values.starts, 5, "starts"),
    settleMs: whole(values["settle-ms"], 30_000, "settle-ms"),
    restMs: whole(values["rest-ms"], 60_000, "rest-ms"),
    record,
    ids: [],
    singleIds: [],
  };

  const health = await request(
    connect(ctx.state),
    "GET",
    "/health",
    undefined,
    { auth: false },
  );
  if (health.status !== 200) {
    throw new Error(
      `the server under ${ctx.state} answered /health with ${health.status}`,
    );
  }
  programSizes(record, values.program ?? []);
  const step = async (name: string, work: () => Promise<void>) => {
    if (skip.has(name)) return;
    log(`step ${name}`);
    await work();
  };

  await step("memory", () =>
    restingMemory(
      ctx,
      "rss_at_rest_empty_mb",
      "Server memory at rest, before the load",
      ctx.settleMs,
    ),
  );
  await step("bulk", async () => {
    await bulkLoad(ctx);
    const started = performance.now();
    await restingMemory(
      ctx,
      "rss_after_bulk_10s_mb",
      "Server memory 10 s after the load",
      Math.min(10_000, ctx.restMs),
    );
    const waited = performance.now() - started;
    await restingMemory(
      ctx,
      "rss_after_bulk_rest_mb",
      `Server memory ${Math.round(ctx.restMs / 1000)} s after the load`,
      Math.max(0, ctx.restMs - waited),
    );
    await databaseSize(ctx, "after_load");
  });
  await step("singles", () => singleCreates(ctx));
  await step("items", () => singleItems(ctx));
  await step("lists", () => lists(ctx));
  await step("search", () => search(ctx));
  await step("warm", async () => {
    await warmStarts(ctx);
    await restingMemory(
      ctx,
      "rss_at_rest_loaded_mb",
      "Server memory at rest after a restart on the loaded database",
      ctx.settleMs,
    );
    await databaseSize(ctx, "after_restarts");
  });
  await step("cold", () => coldStarts(ctx));
  record.finish();
  log(`figures written to ${out}`);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "run") {
    await measure(rest);
  } else if (command === "compare" && rest.length === 2) {
    const table = compare(rest[0] as string, rest[1] as string);
    console.log(table);
  } else {
    console.error(
      "usage: run.ts run --state <dir> --items <n> --out <file> [options] | compare <first.json> <second.json>",
    );
    process.exitCode = 2;
  }
} catch (error) {
  console.error(
    `[slice-bench] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exitCode = 1;
}
