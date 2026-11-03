/**
 * What writing one `parent-of` edge costs on an instance that already holds
 * tens of thousands of them: single requests, each from a deep item to a new
 * leaf.
 *
 * The figure is the whole request. The cycle check inside it cannot be seen
 * from outside, so the ceiling is the request's, not the check's.
 */
import { distribution } from "../../src/utils/scale/figures.js";
import { scaleItem } from "../../src/utils/scale/generator.js";
import { api, log, ok, readFragment, readSample, Recorder } from "./context.js";

const LEAVES = 120;
const WARM_UP = 20;

export async function edges(): Promise<void> {
  const recorder = new Recorder("edges");
  const { childIds } = readSample();
  // Positions far past anything the other steps write, so each is a new leaf.
  const first = 10_000_000;
  const created = await api("POST", "/items/bulk", {
    items: Array.from({ length: LEAVES }, (_, i) => scaleItem(first + i)),
    mode: "upsert",
    atomic: false,
  });
  if (!ok(created))
    throw new Error(`creating the leaves answered ${created.status}`);
  const leafIds = (
    created.json() as { results: { id?: string }[] }
  ).results.map((entry) => entry.id);

  const times: number[] = [];
  let errors = 0;
  for (let i = 0; i < LEAVES; i++) {
    const leaf = leafIds[i];
    if (leaf === undefined) {
      errors++;
      continue;
    }
    const answer = await api("POST", "/edges", {
      source_id: childIds[(i * 3) % childIds.length],
      target_id: leaf,
      edge_type: "parent-of",
    });
    if (!ok(answer)) {
      errors++;
      if (errors === 1)
        log(`parent-of write: ${answer.status} ${answer.text.slice(0, 200)}`);
      continue;
    }
    if (i >= WARM_UP) times.push(answer.ms);
  }
  const held = readFragment("seed")?.figures.find(
    (f) => f.name === "parent_of_edges",
  );
  recorder.add(
    distribution("parent_of_write", "ms", times, {
      errors,
      note: `with ${held === undefined ? "an unknown number of" : held.value.toLocaleString("en-US")} parent-of edges held`,
    }),
  );
  recorder.finish();
}
