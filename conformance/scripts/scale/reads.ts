/**
 * What a person waits for when the server is otherwise quiet: one item, a
 * page of fifty, a search for a word most items hold and one for a word few
 * hold, and a list of notes by title and one of tasks by due date. One request at a time, after
 * warm-up requests nobody counts.
 */
import {
  distribution,
  type Figure,
  type Unit,
} from "../../src/utils/scale/figures.js";
import { RARE_WORD } from "../../src/utils/scale/generator.js";
import { api, ok, readSample, Recorder, log, sleep } from "./context.js";

const WARM_UP = 20;

/** The longest a sorted listing may be asked again for its keys to be ready. */
const KEYS_READY_MS = 120_000;

async function timed(
  name: string,
  unit: Unit,
  samples: number,
  path: (i: number) => string,
  readyUnder?: number,
): Promise<Figure> {
  for (let i = 0; i < WARM_UP; i++) await api("GET", path(i));
  // A sorted listing of a large type scans until the keys it reads are built.
  const gaveUp = performance.now() + KEYS_READY_MS;
  while (readyUnder !== undefined && performance.now() < gaveUp) {
    const answer = await api("GET", path(0));
    if (ok(answer) && answer.ms < readyUnder) break;
    await sleep(500);
  }
  const times: number[] = [];
  let errors = 0;
  for (let i = 0; i < samples; i++) {
    const answer = await api("GET", path(i));
    if (!ok(answer)) {
      errors++;
      if (errors === 1)
        log(`${name}: ${answer.status} ${answer.text.slice(0, 200)}`);
      continue;
    }
    times.push(answer.ms);
  }
  return distribution(name, unit, times, { errors });
}

export async function reads(): Promise<void> {
  const recorder = new Recorder("reads");
  const { ids } = readSample();
  const lists = [
    "/items?limit=50",
    "/items?limit=50&type=core.note",
    "/items?limit=50&type=core.task",
  ];
  recorder.add(
    await timed(
      "get_item",
      "ms",
      300,
      (i) => `/items/${ids[(i * 7) % ids.length]}`,
    ),
  );
  recorder.add(
    await timed("list_50", "ms", 150, (i) => lists[i % lists.length] as string),
  );
  recorder.add(
    await timed("search_common", "ms", 100, () => "/search?q=garden&limit=20"),
  );
  recorder.add(
    await timed(
      "search_rare",
      "ms",
      100,
      () => `/search?q=${RARE_WORD}&limit=20`,
    ),
  );
  recorder.add(
    await timed(
      "list_notes_by_title",
      "ms",
      100,
      () =>
        `/items?limit=50&type=core.note&sort=${encodeURIComponent("properties.title")}`,
      50,
    ),
  );
  recorder.add(
    await timed(
      "list_tasks_by_due",
      "ms",
      100,
      () =>
        `/items?limit=50&type=core.task&sort=${encodeURIComponent("properties.due_at")}`,
      50,
    ),
  );
  recorder.finish();
}
