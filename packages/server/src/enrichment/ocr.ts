import { createWorker } from "tesseract.js";
import type { Worker } from "tesseract.js";

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
  /** Injectable factory for tests; defaults to the real tesseract worker. */
  createWorkerFn?: typeof createWorker;
}

/**
 * Lazy tesseract.js wrapper. The worker (its own worker_thread plus a
 * wasm core) is created on the first `recognize` call, so a deployment
 * that never sees an image never spawns one. `terminate` is idempotent
 * and the engine recovers by recreating the worker on the next call —
 * the sweeper terminates a worker mid-job when a recognition overruns
 * its time budget, which is the only way to actually stop the job.
 */
export class TesseractOcr implements OcrEngine {
  private worker: Promise<Worker> | null = null;

  constructor(private opts: TesseractOcrOptions) {}

  private getWorker(): Promise<Worker> {
    this.worker ??= (this.opts.createWorkerFn ?? createWorker)(
      this.opts.langs ?? "eng",
      undefined,
      { cachePath: this.opts.cachePath },
    );
    return this.worker;
  }

  async recognize(bytes: Buffer): Promise<string> {
    const worker = await this.getWorker();
    const result = await worker.recognize(bytes);
    return result.data.text;
  }

  async terminate(): Promise<void> {
    const pending = this.worker;
    this.worker = null;
    if (!pending) return;
    try {
      const worker = await pending;
      await worker.terminate();
    } catch {
      // A worker that failed to construct has nothing to terminate.
    }
  }
}
