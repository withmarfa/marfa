import {
  getResolvedFields,
  getTypeSchema,
  validateProperties,
} from "@withmarfa/shared";
import { log } from "../middleware/logger.js";
import { publish } from "../pubsub.js";
import type { Storage } from "../storage/interface.js";
import type { BlobLayer } from "../storage/blob-layer.js";
import {
  mergeUpdateProperties,
  resolveIncomingProperties,
} from "../storage/merge-properties.js";
import type { OcrEngine } from "./ocr.js";
import { EXTRACTOR_VERSION, extractText, isEnrichableMime } from "./extract.js";
import {
  DIMENSION_FIELDS,
  deriveDimensions,
  isDimensionMime,
} from "./dimensions.js";
import type { DimensionField, DimensionOutcome } from "./dimensions.js";

export interface TextEnrichmentSweeperOptions {
  storage: Storage;
  blobs: BlobLayer;
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
 * The dimension fields this item could take: the ones its type declares,
 * and only for a MIME a reader would look at.
 *
 * Gated on the type rather than on the MIME alone, because `width` means
 * nothing on a plain `core.file` and writing it there would leave a stray
 * property on a schema with no opinion about it. A custom type that
 * declares the same names gets the same derivation for free, which is the
 * behavior a type registry should have.
 */
function derivableDimensionFields(
  typeId: string,
  mime: string,
): DimensionField[] {
  if (!isDimensionMime(mime)) return [];
  let fields;
  try {
    fields = getResolvedFields(typeId);
  } catch {
    // An unresolvable inheritance chain is the type registry's problem to
    // report, not a reason to fail a derivation over.
    return [];
  }
  if (!fields) return [];
  return DIMENSION_FIELDS.filter((field) => field in fields);
}

/**
 * The validator's complaint about laying `patch` over `current`, or null
 * when the merged result is acceptable. Returns null for a type the
 * registry cannot resolve: no schema is no opinion, not a refusal.
 */
function validationRefusal(
  typeId: string,
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): string | null {
  if (!getTypeSchema(typeId)) return null;
  const merged = mergeUpdateProperties(
    current,
    resolveIncomingProperties(typeId, patch, false) ?? {},
    false,
    "merge",
  );
  const result = validateProperties(typeId, merged);
  if (result.success) return null;
  return `invalid properties: ${result.errors
    .map((e) => `${e.field}: ${e.message}`)
    .join("; ")}`;
}

/**
 * Derives what a file's own bytes can say, on a periodic tick, and writes
 * it back onto the item.
 *
 * Two kinds, both best-effort and neither able to fail a write: text, onto
 * `extracted_text`, which the search indexer picks up on the same write;
 * and dimensions, onto `width`, `height` and `duration` for the types that
 * declare them. A client-supplied value always wins, so derivation fills
 * absences only. An item can take both, either, or neither, and what a kind
 * could not read is recorded with its reason rather than dropped.
 *
 * State-driven, never event-driven: the candidate query is the whole
 * trigger mechanism, so the write the sweeper performs can never feed back
 * as the event that schedules the next sweep. Instance-wide and
 * unsynchronized, like the retention sweeps it is modeled on: nothing
 * claims a candidate, so two processes sweeping at once would each do the
 * extraction.
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

  /**
   * The configuration a skip is decided under. Written onto every state
   * row; the candidate query re-offers skipped rows whose stamp differs,
   * so raising the size ceiling or enabling image reading reconsiders
   * what those settings parked. Fields are limited to what changes a
   * skip/no-skip decision.
   *
   * `max_text_chars` is one of them. It reads like a pure output setting,
   * but the write is validated, so a ceiling set above what the type will
   * accept parks the item instead of storing it, and lowering the ceiling
   * back has to re-offer exactly those rows.
   */
  private get configSignature(): string {
    return JSON.stringify({
      max_blob_bytes: this.opts.maxBlobBytes,
      max_text_chars: this.opts.maxTextChars,
      ocr: this.opts.ocr !== null,
    });
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
      this.configSignature,
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
    type: string;
    blob_ref: string;
    mime_type: string;
  }): Promise<"extracted" | "skipped" | "failed"> {
    const { storage, blobs } = this.opts;
    const prior = await storage.enrichment.get(candidate.item_id);
    // Attempts count against one generation of content: a new blob or a
    // bumped extractor is a fresh start, not attempt N+1 of the old one.
    // Carrying the count across generations meant the first attempt on
    // genuinely new content could already be past the cap.
    const sameGeneration =
      prior !== null &&
      prior.blob_ref === candidate.blob_ref &&
      prior.extractor_version === EXTRACTOR_VERSION;
    const attempts = sameGeneration ? prior.attempts + 1 : 1;

    const record = async (
      status: "skipped" | "failed" | "done",
      error: string | null,
    ) => {
      await storage.enrichment.upsert({
        item_id: candidate.item_id,
        blob_ref: candidate.blob_ref,
        extractor_version: EXTRACTOR_VERSION,
        status,
        attempts,
        error,
        config_signature: this.configSignature,
      });
    };
    // Terminal for this content under this configuration: re-offered only
    // when the blob, the extractor, or the configuration changes.
    const recordSkip = (error: string) => record("skipped", error);
    // Transient: the world was not in the shape the candidate row claimed
    // (a blob write not yet landed, a flaky store read). Recorded as
    // `failed` so the retry budget re-offers it, unlike a skip — a
    // permanent parking is the wrong answer to a temporary miss.
    const recordTransient = async (error: string) => {
      await record("failed", error);
      log("warn", "Text enrichment failed", {
        item_id: candidate.item_id,
        attempts,
        error,
      });
    };

    try {
      // Cheapest gate first: a MIME no reader can handle costs nothing —
      // no metadata lookup, no byte read. Two kinds answer now, so the
      // gate is the union of them: with OCR off, an image still reaches
      // the dimension reader, and a video whose type does not declare
      // width, height or duration still lands here.
      const wantsText = isEnrichableMime(candidate.mime_type, {
        ocrAvailable: this.opts.ocr !== null,
      });
      const derivable = derivableDimensionFields(
        candidate.type,
        candidate.mime_type,
      );
      if (!wantsText && derivable.length === 0) {
        await recordSkip("unsupported type");
        return "skipped";
      }

      const meta = await storage.blobs.get(candidate.blob_ref);
      if (!meta) {
        await recordTransient("blob metadata missing");
        return "failed";
      }
      // Size gate before the read, so an oversized blob costs a metadata
      // lookup rather than its own bytes in memory.
      if (meta.size_bytes > this.opts.maxBlobBytes) {
        await recordSkip("blob exceeds size limit");
        return "skipped";
      }

      // Collected rather than streamed, because every extractor below takes
      // a buffer; the size gate above is what keeps the buffer bounded.
      const bytes = await readAll(blobs, candidate.blob_ref);
      if (!bytes) {
        await recordTransient("blob bytes missing");
        return "failed";
      }

      const patch: Record<string, unknown> = {};
      // Every reason a kind produced nothing, joined onto the row. This is
      // the record a later decision about a native probe rests on: which
      // files this instance holds that nothing here can read, and why.
      const reasons: string[] = [];

      // Dimensions first, and never throwing. Text extraction can blow up
      // (an OCR worker dying is the usual way), and a derivation that would
      // have succeeded must not go down with it.
      if (derivable.length > 0) {
        const derived = await this.deriveWithTimeout(
          bytes,
          candidate.mime_type,
        );
        if (derived.kind === "dimensions") {
          for (const field of derivable) {
            const value = derived.values[field];
            if (typeof value === "number") patch[field] = value;
          }
          const missing = derivable.filter((field) => !(field in patch));
          if (missing.length > 0) {
            reasons.push(`no ${missing.join(", ")} in this file`);
          }
        } else {
          reasons.push(derived.reason);
        }
      }

      // A text extraction that throws is still a transient failure with a
      // retry budget, exactly as before. Captured rather than propagated so
      // a derivation that already succeeded reaches the item instead of
      // being discarded by the outer handler.
      let textError: string | null = null;
      if (wantsText) {
        try {
          const outcome = await this.extractWithTimeout(
            bytes,
            candidate.mime_type,
          );
          if (outcome.kind === "text") patch.extracted_text = outcome.text;
          else {
            reasons.push(
              outcome.kind === "empty" ? "no text found" : "unsupported type",
            );
          }
        } catch (err) {
          textError = err instanceof Error ? err.message : String(err);
        }
      }

      // Re-read before writing: extraction can take most of a minute, and
      // both the write and the bookkeeping must describe the item as it is
      // now, not as the candidate row had it. A gone or re-pointed item
      // gets nothing recorded — the next tick sees the current shape.
      const fresh = await storage.items.get(candidate.item_id);
      if (!fresh) return "skipped";
      if (fresh.properties.blob_ref !== candidate.blob_ref) return "skipped";

      // A client-supplied value always wins; derivation fills absences and
      // nothing else. Judged against the item as it is now and against the
      // type it carries now, both of which may have moved since the
      // candidate row was read.
      const freshFields = derivableDimensionFields(
        fresh.type,
        candidate.mime_type,
      );
      const keeps = (field: string): boolean =>
        !DIMENSION_FIELDS.includes(field as DimensionField) ||
        (freshFields.includes(field as DimensionField) &&
          fresh.properties[field] == null);
      const kept = Object.fromEntries(
        Object.entries(patch).filter(([field]) => keeps(field)),
      );

      if (Object.keys(kept).length === 0) {
        if (textError !== null) {
          await recordTransient(textError);
          return "failed";
        }
        await recordSkip(
          reasons.join("; ") ||
            (Object.keys(patch).length > 0
              ? "already present"
              : "nothing to derive"),
        );
        return "skipped";
      }

      // Judge the merged result before writing it. Neither store validates
      // on update, only on create, so a server-internal writer reaching this
      // door can put a row into a state no caller could have produced, and
      // did: text longer than the type's string ceiling was written
      // successfully and refused every later edit of the item, naming a
      // property nobody had set. Same sequence as the bulk-action runner,
      // through the same helpers, so there is one rule rather than two.
      //
      // Guarded on the schema resolving, because `validateProperties`
      // reports an absent schema as `Unknown type` rather than as no
      // opinion: judging unguarded would park every item of a type this
      // worker's registry does not carry.
      const refusal = validationRefusal(fresh.type, fresh.properties, kept);
      if (refusal) {
        // A skip, never a transient failure. The refusal is a property of
        // the extractor output and the type, both fixed under a given
        // configuration, so retrying it would burn the whole attempt budget
        // to reach the same answer. The config signature is what re-offers
        // it once a ceiling moves.
        await recordSkip(refusal);
        log("warn", "Text enrichment refused by validation", {
          item_id: candidate.item_id,
          type: fresh.type,
          error: refusal,
        });
        return "skipped";
      }

      const updated = await storage.items.update(candidate.item_id, {
        properties: kept,
        version: fresh.version,
      });
      // A conflict response means the item moved between the re-read and
      // the write. Nothing recorded: the row is re-offered next tick and
      // judged against whatever the item has become.
      if (!("id" in updated)) return "skipped";

      if (textError !== null) {
        // Half of it landed. Recorded as a failure anyway, so the retry
        // budget still applies to the half that did not, and the next pass
        // sees the derived fields already present and attempts only text.
        await recordTransient(textError);
      } else {
        // A reason on a done row is the useful case rather than a
        // contradiction: a video that gave up its duration and not its size
        // says exactly that.
        await record("done", reasons.length > 0 ? reasons.join("; ") : null);
      }

      const metadata = await storage.metadata.get(candidate.item_id);
      await publish({
        type: "updated",
        item: updated,
        metadata,
      });
      return textError === null ? "extracted" : "failed";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await record("failed", message.slice(0, 500)).catch(() => {
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
   * cannot be canceled from the outside, so an overrun terminates the
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

  /**
   * Races dimension derivation against the same per-item budget the text
   * side gets, and answers `unreadable` rather than throwing when it runs
   * out: a file that takes too long to read a header from is a file with
   * no dimensions, not a failure to retry.
   *
   * Worth being honest about what the race does and does not bound. The
   * media parser is asynchronous and yields, so the timeout reaches it.
   * The image reader is synchronous: if it ever looped it would hold the
   * event loop and no timer would fire. That is why the reader is one
   * with no published advisory rather than the wider-format alternative
   * whose current release carries three unfixed infinite-loop advisories,
   * one of them in the HEIF parser this most wants. The size gate above
   * bounds the input; the choice of reader bounds the rest.
   */
  private async deriveWithTimeout(
    bytes: Buffer,
    mimeType: string,
  ): Promise<DimensionOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<DimensionOutcome>((resolve) => {
      timer = setTimeout(() => {
        resolve({ kind: "unreadable", reason: "dimension read timed out" });
      }, this.opts.itemTimeoutMs);
    });
    try {
      return await Promise.race([deriveDimensions(bytes, mimeType), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Scheduler entry point: the same logged tick the timer path drives —
   *  `runOnce()` alone is the bare test seam and has no logging. */
  runScheduled(): Promise<void> {
    return this.poll();
  }

  private async poll(): Promise<void> {
    try {
      const result = await this.runOnce();
      if (result.extracted + result.failed > 0) {
        log("info", "Text enrichment sweep", result);
      }
    } catch (err) {
      log("error", "Text enrichment sweep error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** The whole blob from the first attached store that holds it. */
async function readAll(blobs: BlobLayer, hash: string): Promise<Buffer | null> {
  for (const store of blobs.stores) {
    const read = await store.get(hash);
    if (!read) continue;
    const chunks: Buffer[] = [];
    for await (const chunk of read.stream as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  return null;
}
