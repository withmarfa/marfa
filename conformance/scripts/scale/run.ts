// Missed ceilings are recorded here; the judge step decides the nightly result.
import { bulk } from "./bulk.js";
import { conversations } from "./conversations.js";
import { device } from "./device.js";
import { edges } from "./edges.js";
import { exportArchive } from "./export.js";
import { finish, judge } from "./finish.js";
import { folder } from "./folder.js";
import { reads } from "./reads.js";
import { restart } from "./restart.js";
import { seed } from "./seed.js";
import { storage } from "./storage.js";
import { store } from "./store.js";
import { tables } from "./tables.js";
import { watch } from "./watch.js";

const STEPS: Record<string, () => Promise<void> | void> = {
  seed,
  restart,
  reads,
  bulk,
  edges,
  export: exportArchive,
  storage,
  store,
  tables,
  conversations,
  device,
  folder,
  watch,
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
