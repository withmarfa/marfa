/**
 * The steps of the nightly scale benchmark (`benchmarks.yml`, job `scale`),
 * each run as `tsx scripts/scale/run.ts <step>` from the conformance folder
 * with `MARFA_SCALE_STATE` naming the booted server's state directory.
 *
 * A step records its figures whether or not they meet their ceilings and
 * ends normally; one that crashes ends non-zero and leaves what it had
 * recorded. `finish` merges and reports, and `judge` fails the night.
 */
import { bulk } from "./bulk.js";
import { edges } from "./edges.js";
import { exportArchive } from "./export.js";
import { finish, judge } from "./finish.js";
import { reads } from "./reads.js";
import { restart } from "./restart.js";
import { seed } from "./seed.js";
import { storage } from "./storage.js";

const STEPS: Record<string, () => Promise<void> | void> = {
  seed,
  restart,
  reads,
  bulk,
  edges,
  export: exportArchive,
  storage,
  finish,
  judge,
};

const name = process.argv[2] ?? "";
const step = STEPS[name];
if (step === undefined) {
  console.error(`usage: run.ts ${Object.keys(STEPS).join("|")}`);
  process.exit(2);
}
try {
  await step();
} catch (error) {
  console.error(
    `[scale] step ${name} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exitCode = 1;
}
