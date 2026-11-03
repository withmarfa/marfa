/** What the instance weighs at the end of the night, recorded so a drift shows. */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { scalar } from "../../src/utils/scale/figures.js";
import { api, log, ok, Recorder, stateDir } from "./context.js";

const megabytes = (file: string) =>
  existsSync(file) ? statSync(file).size / 1_048_576 : 0;

export async function storage(): Promise<void> {
  const recorder = new Recorder("storage");
  const db = resolve(stateDir(), "marfa.db");
  recorder.add(scalar("db_size", "MB", megabytes(db)));
  recorder.add(scalar("wal_size", "MB", megabytes(`${db}-wal`)));
  const stats = await api("GET", "/items/stats");
  if (ok(stats)) {
    // The answer counts items by state: `{"active": 20120}`.
    const counts = Object.values(
      stats.json() as Record<string, unknown>,
    ).filter((count): count is number => typeof count === "number");
    if (counts.length > 0) {
      recorder.add(
        scalar(
          "rows_items",
          "count",
          counts.reduce((a, b) => a + b, 0),
        ),
      );
    } else {
      log(`/items/stats has no counts: ${stats.text.slice(0, 300)}`);
    }
  } else {
    log(`/items/stats answered ${stats.status}`);
  }
  recorder.finish();
}
