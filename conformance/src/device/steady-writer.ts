import { Worker } from "node:worker_threads";

/** How long a file must stay unchanged before a folder watch may read it. */
const WATCH_SETTLE_MS = 250;

/**
 * Appends to a file from a thread of its own, so a pause in the test's event
 * loop (the scripted server, a long assertion, a collection) cannot leave the
 * file unchanged for as long as a watch waits before reading it.
 *
 * A machine under load can still stall the thread for that long. The file is
 * then quiet, and a watch may rightly send it, so a test that asserts nothing
 * was sent while the file changed asks `neverSettled` once the writer stopped.
 */
export interface SteadyWriter {
  /** Settles once the first append is done, so a watch started afterward
   *  never sees the file before it began to change. */
  started: Promise<void>;
  /** The longest the file stayed unchanged between two appends so far, in
   *  milliseconds, by the status change time a watch reads. */
  longestPause(): number;
  /** Whether no pause so far was long enough to let a watch read the file. */
  neverSettled(): boolean;
  /** Ends the thread once the append in flight is done. */
  stop(): Promise<void>;
}

const SOURCE = `
const { appendFileSync, statSync } = require("node:fs");
const { parentPort, workerData } = require("node:worker_threads");
const { path, every, shared } = workerData;
const state = new Int32Array(shared);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
let last;
let written = 0;
while (Atomics.load(state, 0) === 0) {
  written += 1;
  appendFileSync(path, Buffer.alloc(1024, written % 256));
  const changed = statSync(path, { bigint: true }).ctimeNs;
  if (last === undefined) {
    parentPort.postMessage("started");
  } else {
    const pause = Number((changed - last) / 1000000n);
    if (pause > Atomics.load(state, 1)) Atomics.store(state, 1, pause);
  }
  last = changed;
  Atomics.wait(sleeper, 0, 0, every);
}
`;

export function writeSteadily(path: string, everyMs: number): SteadyWriter {
  const shared = new SharedArrayBuffer(8);
  const state = new Int32Array(shared);
  const worker = new Worker(SOURCE, {
    eval: true,
    workerData: { path, every: everyMs, shared },
  });
  let failure: unknown;
  worker.once("error", (error: unknown) => {
    failure = error;
  });
  const exited = new Promise<void>((resolve) =>
    worker.once("exit", () => resolve()),
  );
  const started = new Promise<void>((resolve) => {
    worker.once("message", () => resolve());
    worker.once("exit", () => resolve());
  });
  const longestPause = () => Atomics.load(state, 1);
  return {
    started,
    longestPause,
    neverSettled: () => longestPause() < WATCH_SETTLE_MS,
    async stop() {
      Atomics.store(state, 0, 1);
      await exited;
      if (failure !== undefined) throw failure as Error;
    },
  };
}
