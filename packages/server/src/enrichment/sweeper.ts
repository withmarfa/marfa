import { log } from "../middleware/logger.js";
import { publish } from "../pubsub.js";
import type { Storage } from "../storage/interface.js";
import type { BlobBackend } from "../storage/blob-backend.js";
import type { OcrEngine } from "./ocr.js";
import { EXTRACTOR_VERSION, extractText } from "./extract.js";

export interface TextEnrichmentSweeperOptions {
  storage: Storage;
  blobs: BlobBackend;
  /** OCR engine, or null when image extraction is disabled. */
  ocr: OcrEngine | null;
  intervalMs: number;
  batchSize: number;
  itemTimeoutMs: number;
  maxBlobBytes: number;
  maxTextChars: number;
  maxAttempts: number;
}

/**
 * Extracts text from file blobs on a periodic tick and writes it back onto
 * the item as `extracted_text`, which the search indexer picks up on the
 * same write.
 *
 * State-driven, never event-driven: the candidate query is the whole
 * trigger mechanism, so the write the sweeper performs can never feed back
 * as the event that schedules the next sweep. Instance-wide with a
 * cluster-wide job lock, like the retention sweeps it is modeled on.
 */
export class TextEnrichmentSweeper {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startupTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: TextEnrichmentSweeperOptions) {}

  start(): void {
    // Same delayed first tick as the retention sweeps: boot is the busiest
    // the process ever is, and nothing here is urgent.
    this.startupTimeout = setTimeout(() => void this.poll(), 20_000);
    this.interval = setInterval(() => void this.poll(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.startupTimeout) {
      clearTimeout(this.startupTimeout);
      this.startupTimeout = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Test entry point — processes one batch and reports what it did. */
  async runOnce(): Promise<{
    extracted: number;
    skipped: number;
    failed: number;
  }> {
    const { storage } = this.opts;
    const candidates = await storage.enrichment.listCandidates(
      EXTRACTOR_VERSION,
      this.opts.maxAttempts,
      this.opts.batchSize,
    );

    let extracted = 0;
    let skipped = 0;
    let failed = 0;

    // Serial on purpose. Extraction is CPU-bound (a wasm OCR core, a zip
    // parser), so running the batch concurrently would compete with the
    // request path on the same event loop for no throughput gain.
    for (const candidate of candidates) {
      const outcome = await this.processOne(candidate);
      if (outcome === "extracted") extracted += 1;
      else if (outcome === "failed") failed += 1;
      else skipped += 1;
    }

    return { extracted, skipped, failed };
  }

  private async processOne(candidate: {
    item_id: string;
    space_id: string | null;
    blob_ref: string;
    mime_type: string;
  }): Promise<"extracted" | "skipped" | "failed"> {
    const { storage, blobs } = this.opts;
    const prior = await storage.enrichment.get(candidate.item_id);
    const attempts = (prior?.attempts ?? 0) + 1;

    const recordSkip = async (error: string) => {
      await storage.enrichment.upsert({
        item_id: candidate.item_id,
        space_id: candidate.space_id,
        blob_ref: candidate.blob_ref,
        extractor_version: EXTRACTOR_VERSION,
        status: "skipped",
        attempts,
        error,
      });
    };

    try {
      const meta = await storage.blobs.get(
        candidate.blob_ref,
        candidate.space_id ?? "",
      );
      if (!meta) {
        await recordSkip("blob metadata missing");
        return "skipped";
      }
      // Size gate before the read, so an oversized blob costs a metadata
      // lookup rather than its own bytes in memory.
      if (meta.size > this.opts.maxBlobBytes) {
        await recordSkip("blob exceeds size limit");
        return "skipped";
      }

      const bytes = await blobs.get(candidate.blob_ref);
      if (!bytes) {
        await recordSkip("blob bytes missing");
        return "skipped";
      }

      const outcome = await this.extractWithTimeout(bytes, candidate.mime_type);
      if (outcome.kind !== "text") {
        await recordSkip(
          outcome.kind === "empty" ? "no text found" : "unsupported type",
        );
        return "skipped";
      }

      const updated = await storage.items.update(
        candidate.item_id,
        { properties: { extracted_text: outcome.text } },
        candidate.space_id ?? undefined,
      );
      // A conflict response means the item moved under us (or vanished).
      // Nothing to record against a row that is no longer the one we read.
      if (!("id" in updated)) return "skipped";

      await storage.enrichment.upsert({
        item_id: candidate.item_id,
        space_id: candidate.space_id,
        blob_ref: candidate.blob_ref,
        extractor_version: EXTRACTOR_VERSION,
        status: "done",
        attempts,
        error: null,
      });

      const metadata = await storage.metadata.get(candidate.item_id);
      await publish({
        type: "updated",
        item: updated,
        metadata,
        spaceId: candidate.space_id ?? undefined,
      });
      return "extracted";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await storage.enrichment
        .upsert({
          item_id: candidate.item_id,
          space_id: candidate.space_id,
          blob_ref: candidate.blob_ref,
          extractor_version: EXTRACTOR_VERSION,
          status: "failed",
          attempts,
          error: message.slice(0, 500),
        })
        .catch(() => {
          // The item may have been deleted mid-extraction, taking the FK
          // target with it. Losing the bookkeeping row for a gone item is
          // the correct outcome.
        });
      log("warn", "Text enrichment failed", {
        item_id: candidate.item_id,
        attempts,
        error: message,
      });
      return "failed";
    }
  }

  /**
   * Races extraction against a per-item budget. A tesseract recognition
   * cannot be cancelled from the outside, so an overrun terminates the
   * worker: the engine recreates it on the next call, and the alternative
   * is a wedged sweep that never reaches the rest of the batch.
   */
  private async extractWithTimeout(
    bytes: Buffer,
    mimeType: string,
  ): ReturnType<typeof extractText> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("extraction timed out"));
      }, this.opts.itemTimeoutMs);
    });
    try {
      return await Promise.race([
        extractText(bytes, mimeType, {
          maxTextChars: this.opts.maxTextChars,
          ocr: this.opts.ocr,
        }),
        timeout,
      ]);
    } catch (err) {
      await this.opts.ocr?.terminate().catch(() => {
        // A worker that cannot be terminated is replaced on next use.
      });
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async poll(): Promise<void> {
    try {
      const result = await this.opts.storage.coordination.withJobLock(
        "enrichment-sweep",
        () => this.runOnce(),
      );
      if (result && result.extracted + result.failed > 0) {
        log("info", "Text enrichment sweep", result);
      }
    } catch (err) {
      log("error", "Text enrichment sweep error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
