/** What the instance weighs at the end of the night, recorded so a drift shows. */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { scalar } from "../../src/utils/scale/figures.js";
import { judgeItemTotal } from "../../src/utils/scale/judging.js";
import {
  api,
  readFragment,
  Recorder,
  stateDir,
  targetItems,
} from "./context.js";

const megabytes = (file: string) =>
  existsSync(file) ? statSync(file).size / 1_048_576 : 0;

/**
 * The items the seed step says it wrote: the instance must hold at least that
 * many, or every figure above describes a smaller instance than the one it
 * names.
 */
export function claimedItems(): number {
  return (
    readFragment("seed")?.items ??
    readFragment("seed", true)?.items ??
    targetItems()
  );
}

export async function storage(): Promise<void> {
  const recorder = new Recorder("storage");
  const db = resolve(stateDir(), "marfa.db");
  recorder.add(scalar("db_size", "MB", megabytes(db)));
  recorder.add(scalar("wal_size", "MB", megabytes(`${db}-wal`)));
  const stats = await api("GET", "/items/stats");
  const total = judgeItemTotal(stats.status, stats.text, claimedItems());
  recorder.add(
    scalar("rows_items", "count", total.value, {
      errors: total.errors,
      ...(total.note === null ? {} : { note: total.note }),
    }),
  );
  recorder.finish();
}
