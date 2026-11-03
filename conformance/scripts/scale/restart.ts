/**
 * Stops and starts the server on its data, four times, and reads its memory
 * once it has settled.
 *
 * The time is the whole restart: the stop, the start of the built server and the
 * boot script's own sign-in once `/health` answers, which adds a little to
 * what a person waits for. The first restart follows the seeding, so it also
 * pays for checkpointing a database just written; it is recorded on its own, and the figure with the ceiling is
 * the slowest of the three after it. Three are too few for a p95 to mean more
 * than that, and the slowest is the stricter reading.
 */
import { restartServer } from "../marfa-server.js";
import { scalar } from "../../src/utils/scale/figures.js";
import { readServerMemory } from "../../src/utils/scale/memory.js";
import { log, Recorder, sleep, stateDir, supervisorPid } from "./context.js";

const WARM_UP_RESTARTS = 1;
const RESTARTS = 3;
/** Long enough for start-up work to finish, so the reading is a resting one. */
const SETTLE_MS = Number(process.env.MARFA_SCALE_SETTLE_MS ?? "30000");

export async function restart(): Promise<void> {
  const recorder = new Recorder("restart");
  const times: number[] = [];
  let first = 0;
  for (let i = 0; i < WARM_UP_RESTARTS + RESTARTS; i++) {
    const started = performance.now();
    await restartServer({ state: stateDir() }, "SIGTERM");
    const took = performance.now() - started;
    log(`restart ${i + 1} took ${Math.round(took)} ms`);
    if (i < WARM_UP_RESTARTS) first = took;
    else times.push(took);
  }
  recorder.add(scalar("server_restart_first", "ms", first));
  recorder.add(
    scalar("server_restart", "ms", Math.max(...times), {
      note: `the slowest of ${times.length} restarts after the first`,
    }),
  );
  await sleep(SETTLE_MS);
  const memory = readServerMemory(supervisorPid());
  recorder.add(scalar("rss_at_rest", "MB", memory.rssMb));
  recorder.finish();
}
