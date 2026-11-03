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
import {
  distribution,
  RSS_MARGIN_AFTER_BULK_MB,
  scalar,
} from "../../src/utils/scale/figures.js";
import { scaleItem } from "../../src/utils/scale/generator.js";
import { readServerMemory } from "../../src/utils/scale/memory.js";
import {
  judgePage,
  sumPageErrors,
  type PageJudgement,
} from "../../src/utils/scale/judging.js";
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
const TEN_SECONDS_MS = Number(process.env.MARFA_SCALE_TEN_S_MS ?? "10000");
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

/** The ids of the entries a bulk answer says it created, in order. */
function newIds(text: string): string[] {
  try {
    const results = (
      JSON.parse(text) as {
        results?: { outcome?: string; id?: string }[];
      }
    ).results;
    return (results ?? []).flatMap((entry) =>
      entry.outcome === "created" && typeof entry.id === "string"
        ? [entry.id]
        : [],
    );
  } catch {
    return [];
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
    run: { get: ReaderResult; health: ReaderResult },
    page: PageJudgement,
  ) => {
    // A page that fell short measured less work than it claims, so it fails
    // both figures: each entry it did not write counts as an error.
    const options = (readerErrors: number) => ({
      errors: readerErrors + page.errors,
      ...(page.note === null ? {} : { note: page.note }),
    });
    recorder.add(
      distribution(
        `read_get_during_${kind}_bulk`,
        "ms",
        run.get.times,
        options(run.get.errors),
      ),
    );
    recorder.add(
      distribution(
        `read_health_during_${kind}_bulk`,
        "ms",
        run.health.times,
        options(run.health.errors),
      ),
    );
  };

  /** Sends one page and judges what it wrote by its counts. */
  const sendPage = async (path: string, body: string, size: number) => {
    const answer = await api("POST", path, body);
    return {
      ms: answer.ms,
      text: answer.text,
      judgement: judgePage(answer.status, answer.text, size),
    };
  };

  // The resting reading to compare with: the restart step's, else now.
  const restFigure = readFragment("restart")?.figures.find(
    (figure) => figure.name === "rss_at_rest",
  );
  const rest = restFigure?.value ?? readServerMemory(supervisorPid()).rssMb;

  // 1. A 5,000-entry page in the default (atomic) mode.
  const atomicBody = pageBody(takePositions(PAGE), PAGE, undefined);
  const atomic = await withReaders(ids, () =>
    sendPage("/items/bulk", atomicBody, PAGE),
  );
  readerFigures("atomic", atomic, atomic.written.judgement);
  log(
    `the atomic page took ${Math.round(atomic.written.ms)} ms; reading memory after 10 s and after a minute`,
  );

  // The server hands memory back soon after bulk work stops (#2609), so the
  // first reading is 10 s after the page ends, at rest plus a margin.
  await sleep(TEN_SECONDS_MS);
  const soon = readServerMemory(supervisorPid());
  recorder.add(
    scalar("rss_after_bulk_10s", "MB", soon.rssMb, {
      ceiling: rest + RSS_MARGIN_AFTER_BULK_MB,
      note: `resting reading was ${rest.toFixed(1)} MB; the ceiling is that plus ${RSS_MARGIN_AFTER_BULK_MB} MB`,
    }),
  );
  await sleep(Math.max(0, MINUTE_MS - TEN_SECONDS_MS));
  const after = readServerMemory(supervisorPid());
  recorder.add(scalar("rss_after_bulk_1min", "MB", after.rssMb));
  recorder.add(
    scalar("rss_growth_after_bulk", "MB", after.rssMb - rest, {
      note: `resting reading was ${rest.toFixed(1)} MB`,
    }),
  );

  // 2. A 5,000-entry best-effort page, as the core's drain sends it.
  const bestBody = pageBody(takePositions(PAGE), PAGE, false);
  const best = await withReaders(ids, () =>
    sendPage("/items/bulk", bestBody, PAGE),
  );
  readerFigures("best_effort", best, best.written.judgement);

  // 3. A 2,000-entry page of `about` edges. An `about` edge runs from any
  // type to any type, many to many, and refuses a self-loop and a repeat of
  // a triple. Each edge here runs from an item the page above just created
  // to one the seed made, so no edge repeats one the instance holds, none
  // is a loop, and both ends are known to exist: the page must create all of
  // them, which is checked by its counts.
  const created = newIds(best.written.text);
  const pool = ids.slice(0, Math.min(ids.length, 1_000));
  const edges = created.slice(0, EDGE_PAGE).map((source, i) => ({
    source_id: source,
    target_id: pool[i % pool.length] as string,
    edge_type: "about",
  }));
  if (edges.length < EDGE_PAGE) {
    log(
      `the best-effort page left ${edges.length} new items to link, not ${EDGE_PAGE}`,
    );
  }
  const edgeBody = JSON.stringify({ edges, mode: "upsert", atomic: false });
  const edgeRun = await withReaders(ids, () =>
    sendPage("/edges/bulk", edgeBody, EDGE_PAGE),
  );
  readerFigures("edge", edgeRun, edgeRun.written.judgement);

  // 4. The same number of entries in pages of 100.
  const small = takePositions(PAGE);
  let smallMs = 0;
  const smallPages: PageJudgement[] = [];
  for (let first = small; first < small + PAGE; first += SMALL_PAGE) {
    const page = await sendPage(
      "/items/bulk",
      pageBody(first, SMALL_PAGE, false),
      SMALL_PAGE,
    );
    smallMs += page.ms;
    smallPages.push(page.judgement);
  }
  const largePerEntry = best.written.ms / PAGE;
  const smallPerEntry = smallMs / PAGE;
  const large = best.written.judgement;
  const smallSum = sumPageErrors(smallPages);
  const note = (judgement: PageJudgement) =>
    judgement.note === null ? {} : { note: judgement.note };
  recorder.add(
    scalar("bulk_page_5000_per_entry", "ms", largePerEntry, {
      errors: large.errors,
      ...note(large),
    }),
  );
  recorder.add(
    scalar("bulk_page_100_per_entry", "ms", smallPerEntry, {
      errors: smallSum.errors,
      ...note(smallSum),
    }),
  );
  recorder.add(
    scalar("bulk_page_ratio", "ratio", largePerEntry / smallPerEntry, {
      errors: large.errors + smallSum.errors,
      ...note(large.errors > 0 ? large : smallSum),
    }),
  );

  const peak = readServerMemory(supervisorPid()).peakMb;
  if (peak !== null) recorder.add(scalar("rss_peak", "MB", peak));
  recorder.finish();
}
