import { Worker } from "node:worker_threads";

/**
 * Appends to a file from a thread of its own, so a pause in the test's event
 * loop (the scripted server, a long assertion, a collection) cannot leave the
 * file unchanged for as long as a watch waits before reading it.
 */
export interface SteadyWriter {
  /** The longest time between two appends so far, in milliseconds. */
  longestPause(): number;
  /** Ends the thread once the append in flight is done. */
  stop(): Promise<void>;
}

const SOURCE = `
const { appendFileSync } = require("node:fs");
const { workerData } = require("node:worker_threads");
const { path, every, shared } = workerData;
const state = new Int32Array(shared);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
let last = Date.now();
let written = 0;
while (Atomics.load(state, 0) === 0) {
  written += 1;
  appendFileSync(path, Buffer.alloc(1024, written % 256));
  const now = Date.now();
  if (now - last > Atomics.load(state, 1)) Atomics.store(state, 1, now - last);
  last = now;
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
  return {
    longestPause: () => Atomics.load(state, 1),
    async stop() {
      Atomics.store(state, 0, 1);
      await exited;
      if (failure !== undefined) throw failure as Error;
    },
  };
}
