/**
 * Fills the instance with `MARFA_SCALE_ITEMS` items and their edges, in pages
 * of 1,000 (what the core's drain sends), and records the rate and what the
 * server refused.
 *
 * A page the server refuses is counted and reported, never skipped over
 * quietly: `items_seeded` is the count the server confirmed, `seed_errors`
 * fails the night above zero, and the merged file takes the instance's size
 * from the count and not from the target. Three refused pages in a row end
 * the seeding, since going on would only measure a smaller instance.
 */
import { writeFileSync } from "node:fs";
import { edgePlan, scaleItem } from "../../src/utils/scale/generator.js";
import { scalar } from "../../src/utils/scale/figures.js";
import type { BulkEdgeResponse, BulkResponse } from "../../src/client/types.js";
import {
  api,
  log,
  ok,
  Recorder,
  sampleFile,
  targetItems,
  type Sample,
} from "./context.js";

const PAGE = 1_000;
const GIVE_UP_AFTER_REFUSED_PAGES = 3;
const SAMPLE_IDS = 2_000;
const SAMPLE_CHILDREN = 500;

export async function seed(): Promise<void> {
  const target = targetItems();
  const recorder = new Recorder("seed");
  // Position -> id, from 1.
  const ids: (string | undefined)[] = new Array<string | undefined>(target + 1);
  let created = 0;
  let errors = 0;
  let parentEdges = 0;
  let aboutEdges = 0;
  let refusedInARow = 0;
  const started = performance.now();

  for (let from = 1; from <= target; from += PAGE) {
    const to = Math.min(target, from + PAGE - 1);
    const items = [];
    for (let n = from; n <= to; n++) items.push(scaleItem(n));
    const answer = await api("POST", "/items/bulk", {
      items,
      mode: "upsert",
      atomic: false,
    });
    if (!ok(answer)) {
      errors += items.length;
      refusedInARow++;
      log(
        `items ${from}-${to} refused with ${answer.status}: ${answer.text.slice(0, 300)}`,
      );
      if (refusedInARow >= GIVE_UP_AFTER_REFUSED_PAGES) break;
      continue;
    }
    refusedInARow = 0;
    const body = answer.json() as BulkResponse;
    for (const entry of body.results) {
      if (entry.id !== undefined) {
        ids[from + entry.index] = entry.id;
        created++;
      }
    }
    errors += body.counts.errored;
    if (body.counts.errored > 0) {
      const first = body.results.find((entry) => entry.outcome === "errored");
      log(
        `${body.counts.errored} entries errored in ${from}-${to}: ${JSON.stringify(first?.error)}`,
      );
    }

    const edges = [];
    for (let n = from; n <= to; n++) {
      const plan = edgePlan(n);
      const self = ids[n];
      if (self === undefined) continue;
      const parent = plan.parent === null ? undefined : ids[plan.parent];
      if (parent !== undefined) {
        edges.push({
          source_id: parent,
          target_id: self,
          edge_type: "parent-of",
        });
      }
      const about = plan.about === null ? undefined : ids[plan.about];
      if (about !== undefined) {
        edges.push({ source_id: self, target_id: about, edge_type: "about" });
      }
    }
    if (edges.length > 0) {
      const edgeAnswer = await api("POST", "/edges/bulk", {
        edges,
        mode: "upsert",
        atomic: false,
      });
      if (!ok(edgeAnswer)) {
        errors += edges.length;
        log(
          `edges for ${from}-${to} refused with ${edgeAnswer.status}: ${edgeAnswer.text.slice(0, 300)}`,
        );
      } else {
        const result = edgeAnswer.json() as BulkEdgeResponse;
        errors += result.counts.errored;
        for (const entry of result.results) {
          if (entry.id === undefined) continue;
          if (edges[entry.index]?.edge_type === "parent-of") parentEdges++;
          else aboutEdges++;
        }
      }
    }
    if ((from - 1) % (PAGE * 10) === 0) {
      log(
        `${created.toLocaleString()} items and ${(parentEdges + aboutEdges).toLocaleString()} edges so far`,
      );
    }
  }

  const seconds = (performance.now() - started) / 1000;
  const present = ids.flatMap((id, position) =>
    id === undefined ? [] : [position],
  );
  const stride = Math.max(1, Math.floor(present.length / SAMPLE_IDS));
  const children = present.filter((n) => edgePlan(n).parent !== null);
  const childStride = Math.max(
    1,
    Math.floor(children.length / SAMPLE_CHILDREN),
  );
  const sample: Sample = {
    ids: present
      .filter((_, i) => i % stride === 0)
      .map((n) => ids[n] as string),
    childIds: children
      .filter((_, i) => i % childStride === 0)
      .map((n) => ids[n] as string),
  };
  writeFileSync(sampleFile(), JSON.stringify(sample));

  recorder.learnedItems(created);
  recorder.add(scalar("items_seeded", "count", created));
  recorder.add(
    scalar("seed_errors", "count", errors, {
      note:
        errors > 0
          ? `the target was ${target} items and the server confirmed ${created}`
          : undefined,
    }),
  );
  // Items a second over the whole seeding, edges included, as a drain sends them.
  recorder.add(scalar("seed_rate", "per_s", created / seconds));
  recorder.add(scalar("parent_of_edges", "count", parentEdges));
  recorder.add(scalar("about_edges", "count", aboutEdges));
  recorder.finish();
  if (errors > 0 || created < target) process.exitCode = 1;
}
