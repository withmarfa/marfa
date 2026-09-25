import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

export const OCR_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/bmp",
]);

/**
 * The sweeper's OCR seam. The real engine wraps tesseract.js; tests
 * inject a fake so no unit run ever touches the network (the engine
 * fetches its language model on first use).
 */
export interface OcrEngine {
  recognize(bytes: Buffer): Promise<string>;
  terminate(): Promise<void>;
}

export interface TesseractOcrOptions {
  /** Directory the language model is cached in across runs. */
  cachePath: string;
  /** Language model(s) to load; tesseract's identifier format. */
  langs?: string;
  /**
   * Starts the thread the engine runs in; tests pass one running a fake.
   * The thread answers `{ id, bytes }` with `{ id, text }` or
   * `{ id, error }`, and may end at any moment.
   */
  spawnThread?: () => Worker;
}

/**
 * tesseract.js inside a thread of the server's own. The library throws out
 * of its message listeners, where nothing can catch it: a job it refused
 * (an image its decoder cannot read), a language model that failed to
 * download or is corrupt in the cache, or its own thread dying while it
 * starts. Any of those in the server's thread ends the process. In this
 * thread it ends the thread, whose `error` and `exit` this class hears, so
 * the job fails and the next recognition starts a fresh thread.
 */
const THREAD = `
const { mkdirSync } = require("node:fs");
const { parentPort, workerData } = require("node:worker_threads");
const { createWorker } = require(workerData.tesseract);
let engine = null;
let current = null;
function fail(error) {
  if (current !== null) {
    parentPort.postMessage({ id: current, error: String(error) });
    current = null;
  }
  // The library's own state after a refusal is not known, so the thread
  // ends and the next job starts from nothing.
  process.exit(1);
}
parentPort.on("message", async ({ id, bytes }) => {
  current = id;
  try {
    // The library writes its model into the cache only when the directory
    // is there, and fetches it again on every start otherwise.
    mkdirSync(workerData.cachePath, { recursive: true });
    // A refusal would end this thread anyway, thrown from the library's
    // listener; handling it answers the job with the library's own reason.
    engine ??= createWorker(workerData.langs, undefined, {
      cachePath: workerData.cachePath,
      errorHandler: fail,
    });
    const result = await (await engine).recognize(Buffer.from(bytes));
    if (current === id) {
      parentPort.postMessage({ id, text: result.data.text });
      current = null;
    }
  } catch (error) {
    fail(error);
  }
});
`;

interface Pending {
  thread: Worker;
  resolve: (text: string) => void;
  reject: (e: Error) => void;
}

export class TesseractOcr implements OcrEngine {
  private thread: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 0;
  /** The thread takes one job at a time, so a recognition waits for the one
   *  before it to settle. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private opts: TesseractOcrOptions) {}

  private spawn(): Worker {
    if (this.opts.spawnThread) return this.opts.spawnThread();
    return new Worker(THREAD, {
      eval: true,
      workerData: {
        tesseract: createRequire(import.meta.url).resolve("tesseract.js"),
        langs: this.opts.langs ?? "eng",
        cachePath: this.opts.cachePath,
      },
    });
  }

  /** Fails every job the thread held, and forgets the thread if it is still
   *  the current one. A thread's `exit` can arrive after its replacement has
   *  taken jobs, so only its own are failed. */
  private lose(thread: Worker, error: Error): void {
    if (this.thread === thread) this.thread = null;
    for (const [id, job] of this.pending) {
      if (job.thread !== thread) continue;
      this.pending.delete(id);
      job.reject(error);
    }
  }

  private getThread(): Worker {
    if (this.thread) return this.thread;
    const thread = this.spawn();
    thread.on(
      "message",
      (answer: { id: number; text?: string; error?: string }) => {
        const job = this.pending.get(answer.id);
        if (!job) return;
        this.pending.delete(answer.id);
        if (answer.error !== undefined) {
          // The next job goes to a fresh thread, and this one is ended
          // rather than trusted to end itself.
          if (this.thread === thread) this.thread = null;
          void thread.terminate();
          job.reject(new Error(answer.error));
        } else {
          job.resolve(answer.text ?? "");
        }
      },
    );
    thread.on("error", (error: unknown) => {
      this.lose(
        thread,
        error instanceof Error ? error : new Error(String(error)),
      );
    });
    thread.on("exit", (code) => {
      this.lose(
        thread,
        new Error(`the OCR thread ended with code ${String(code)}`),
      );
    });
    this.thread = thread;
    return thread;
  }

  recognize(bytes: Buffer): Promise<string> {
    const run = this.queue.then(() => this.send(bytes));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private send(bytes: Buffer): Promise<string> {
    const thread = this.getThread();
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { thread, resolve, reject });
      thread.postMessage({ id, bytes });
    });
  }

  /** Ends the thread, however far its engine got, failing any job it held.
   *  The next recognition starts a fresh one. */
  async terminate(): Promise<void> {
    const thread = this.thread;
    if (!thread) return;
    this.lose(thread, new Error("the OCR thread was stopped"));
    await thread.terminate();
  }
}
