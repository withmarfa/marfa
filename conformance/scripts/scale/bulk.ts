/**
 * Reads while a large bulk page is written, what the page costs per entry
 * against smaller pages, and what the server's memory does afterwards.
 *
 * Two readers poll `GET /items/{id}` and `/health` while each page runs. The
 * page's body is serialized before they start and its answer is parsed after
 * they stop, so this process's own work does not show up as the server's
 * wait.
 *
 * The first page is in the default (atomic) mode; the second is best-effort,
 * which is what the core's drain sends. Memory is read a minute after the
 * first page.
 */
import { distribution, scalar } from "../../src/utils/scale/figures.js";
import { scaleItem } from "../../src/utils/scale/generator.js";
import { readServerMemory } from "../../src/utils/scale/memory.js";
import {
  api,
  log,
  ok,
  readFragment,
  readSample,
  Recorder,
  sleep,
  supervisorPid,
  targetItems,
} from "./context.js";

const PAGE = 5_000;
const EDGE_PAGE = 2_000;
const SMALL_PAGE = 100;
const MINUTE_MS = Number(process.env.MARFA_SCALE_MINUTE_MS ?? "60000");
/** Between two polls of one reader, so a reader is a person and not a flood. */
const POLL_GAP_MS = 10;

interface ReaderResult {
  times: number[];
  errors: number;
}

/** Runs `write` while two readers poll, and returns what each saw. */
async function withReaders<T>(
  ids: string[],
  write: () => Promise<T>,
): Promise<{ written: T; get: ReaderResult; health: ReaderResult }> {
  let running = true;
  const reader = async (path: (i: number) => string): Promise<ReaderResult> => {
    const result: ReaderResult = { times: [], errors: 0 };
    for (let i = 0; running; i++) {
      const answer = await api("GET", path(i));
      if (ok(answer)) result.times.push(answer.ms);
      else result.errors++;
      await sleep(POLL_GAP_MS);
    }
    return result;
  };
  const get = reader((i) => `/items/${ids[(i * 13) % ids.length]}`);
  const health = reader(() => "/health");
  try {
    const written = await write();
    running = false;
    return { written, get: await get, health: await health };
  } catch (error) {
    running = false;
    await Promise.allSettled([get, health]);
    throw error;
  }
}

function pageBody(first: number, count: number, atomic: boolean | undefined) {
  const items = [];
  for (let n = first; n < first + count; n++) items.push(scaleItem(n));
  return JSON.stringify({
    items,
    mode: "upsert",
    ...(atomic === undefined ? {} : { atomic }),
  });
}

export async function bulk(): Promise<void> {
  const recorder = new Recorder("bulk");
  const { ids } = readSample();
  let next = targetItems() + 1;
  const takePositions = (count: number) => {
    const first = next;
    next += count;
    return first;
  };

  const readerFigures = (
    kind: "atomic" | "best_effort" | "edge",
    run: {
      get: ReaderResult;
      health: ReaderResult;
      written: { status: number };
    },
  ) => {
    // A page the server refused measured nothing, so it fails both figures.
    const refused = run.written.status === 200 ? 0 : 1;
    recorder.add(
      distribution(`read_get_during_${kind}_bulk`, "ms", run.get.times, {
        errors: run.get.errors + refused,
      }),
    );
    recorder.add(
      distribution(`read_health_during_${kind}_bulk`, "ms", run.health.times, {
        errors: run.health.errors + refused,
      }),
    );
  };

  // The resting reading to compare with: the restart step's, else now.
  const restFigure = readFragment("restart")?.figures.find(
    (figure) => figure.name === "rss_at_rest",
  );
  const rest = restFigure?.value ?? readServerMemory(supervisorPid()).rssMb;

  // 1. A 5,000-entry page in the default (atomic) mode.
  const atomicBody = pageBody(takePositions(PAGE), PAGE, undefined);
  const atomic = await withReaders(ids, async () => {
    const answer = await api("POST", "/items/bulk", atomicBody);
    return { status: answer.status, ms: answer.ms };
  });
  readerFigures("atomic", atomic);
  log(
    `the atomic page took ${Math.round(atomic.written.ms)} ms; waiting a minute before reading memory`,
  );

  await sleep(MINUTE_MS);
  const after = readServerMemory(supervisorPid());
  recorder.add(scalar("rss_after_bulk_1min", "MB", after.rssMb));
  recorder.add(
    scalar("rss_growth_after_bulk", "MB", after.rssMb - rest, {
      note: `resting reading was ${rest.toFixed(1)} MB`,
    }),
  );

  // 2. A 5,000-entry best-effort page, as the core's drain sends it.
  const bestBody = pageBody(takePositions(PAGE), PAGE, false);
  const best = await withReaders(ids, async () => {
    const answer = await api("POST", "/items/bulk", bestBody);
    return { status: answer.status, ms: answer.ms };
  });
  readerFigures("best_effort", best);

  // 3. A 2,000-entry page of edges between items already there.
  const pool = ids.slice(0, Math.min(ids.length, 1_000));
  const edges = [];
  for (let i = 0; i < EDGE_PAGE; i++) {
    edges.push({
      source_id: pool[i % pool.length] as string,
      target_id: pool[
        ((i % pool.length) + 1 + Math.floor(i / pool.length)) % pool.length
      ] as string,
      edge_type: "about",
    });
  }
  const edgeBody = JSON.stringify({ edges, mode: "upsert", atomic: false });
  const edgeRun = await withReaders(ids, async () => {
    const answer = await api("POST", "/edges/bulk", edgeBody);
    return { status: answer.status, ms: answer.ms };
  });
  readerFigures("edge", edgeRun);

  // 4. The same number of entries in pages of 100.
  const small = takePositions(PAGE);
  let smallMs = 0;
  let smallErrors = 0;
  for (let first = small; first < small + PAGE; first += SMALL_PAGE) {
    const answer = await api(
      "POST",
      "/items/bulk",
      pageBody(first, SMALL_PAGE, false),
    );
    smallMs += answer.ms;
    if (!ok(answer)) smallErrors++;
  }
  const largePerEntry = best.written.ms / PAGE;
  const smallPerEntry = smallMs / PAGE;
  const errored = (best.written.status === 200 ? 0 : 1) + smallErrors;
  recorder.add(
    scalar("bulk_page_5000_per_entry", "ms", largePerEntry, {
      errors: best.written.status === 200 ? 0 : 1,
    }),
  );
  recorder.add(
    scalar("bulk_page_100_per_entry", "ms", smallPerEntry, {
      errors: smallErrors,
    }),
  );
  recorder.add(
    scalar("bulk_page_ratio", "ratio", largePerEntry / smallPerEntry, {
      errors: errored,
    }),
  );

  const peak = readServerMemory(supervisorPid()).peakMb;
  if (peak !== null) recorder.add(scalar("rss_peak", "MB", peak));
  recorder.finish();
}
